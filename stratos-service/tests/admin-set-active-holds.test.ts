import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import { applyEnrollmentHolds } from '../src/features/enrollment/index.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import {
  buildSetActiveHarness,
  defineSetActiveScenarios,
  RESERVED_BOUNDARY,
  rowOf,
  seedMember,
  SPIKE_DID,
  type HoldsBackend,
} from './helpers/enrollment-holds.js'

describe('admin setActive with operator and takedown holds on SQLite', () => {
  let tmp: string
  let db: ServiceDb
  let backend: HoldsBackend

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stratos-set-active-holds-'))
    const dbPath = join(tmp, 'service.sqlite')
    db = createServiceDb(dbPath)
    await migrateServiceDb(db)
    backend = {
      enrollmentStore: new ReservedDomainEnrollmentStore(
        new SqliteEnrollmentStore(db),
        RESERVED_BOUNDARY,
      ),
      labelStore: new SqliteLabelStore(db, dbPath),
    }
  })

  afterEach(async () => {
    await closeServiceDb(db)
    rmSync(tmp, { recursive: true, force: true })
  })

  defineSetActiveScenarios(() => backend)

  it('stops resolving a member after setActive false within the cache TTL', async () => {
    const harness = buildSetActiveHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    const resolve = async () => {
      const app = harness.ctx.app as express.Application
      return new Promise<{ enrolled: boolean }>((done, fail) => {
        const req = {
          query: { did: SPIKE_DID },
          headers: {},
          method: 'GET',
          url: '/xrpc/zone.stratos.identity.resolveEnrollments',
        } as unknown as express.Request
        const res = {
          status: () => res,
          json: (body: { enrolled: boolean }) => done(body),
          setHeader: () => res,
        } as unknown as express.Response
        app(req, res, (err?: unknown) => fail(err as Error))
      })
    }

    expect((await resolve()).enrolled).toBe(true)
    await harness.setActive(SPIKE_DID, false)

    expect((await resolve()).enrolled).toBe(false)
  })

  it('leaves the row untouched while another writer holds the repo lock', async () => {
    const harness = buildSetActiveHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    const before = await rowOf(backend, SPIKE_DID)
    const release = await harness.ctx.repoWriteLocks.acquire(SPIKE_DID)

    const pending = harness.setActive(SPIKE_DID, false)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await rowOf(backend, SPIKE_DID)).toEqual(before)
    release()
    await pending
    const after = await rowOf(backend, SPIKE_DID)
    expect(after?.operatorHold).toBe(true)
    expect(after?.active).toBe(false)
  })

  it('writes nothing and signals nothing when the change changes nothing', async () => {
    const harness = buildSetActiveHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    const before = await rowOf(backend, SPIKE_DID)
    const update = vi.spyOn(backend.enrollmentStore, 'updateEnrollment')

    const noHoldChange = await applyEnrollmentHolds(harness.ctx, SPIKE_DID, {
      operatorHold: false,
    })
    const emptyChange = await applyEnrollmentHolds(harness.ctx, SPIKE_DID, {})

    expect(noHoldChange).toEqual({ active: true, operatorHold: false })
    expect(emptyChange).toEqual({ active: true, operatorHold: false })
    expect(update).not.toHaveBeenCalled()
    expect(harness.signals).toEqual([])
    expect(await rowOf(backend, SPIKE_DID)).toEqual(before)
    update.mockRestore()
  })

  it('writes once and signals once when the change deactivates the member', async () => {
    const harness = buildSetActiveHarness(backend)
    await seedMember(backend, { did: SPIKE_DID })
    const update = vi.spyOn(backend.enrollmentStore, 'updateEnrollment')

    const held = await applyEnrollmentHolds(harness.ctx, SPIKE_DID, {
      operatorHold: true,
    })

    expect(held).toEqual({ active: false, operatorHold: true })
    expect(update).toHaveBeenCalledTimes(1)
    expect(harness.signals).toEqual([SPIKE_DID])
    update.mockRestore()
  })
})
