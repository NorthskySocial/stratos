import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteEnrollmentStore } from '../src/storage/sqlite/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import { EnrollmentServiceImpl } from '../src/features/enrollment/adapter.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import {
  buildCallbackHarness,
  buildSetActiveHarness,
  defineCallbackHoldScenarios,
  ED_DID,
  ENROLLMENT_DENIED_BODY,
  expectNothingProvisioned,
  FAYE_DID,
  JET_DID,
  RESERVED_BOUNDARY,
  rowOf,
  seedMember,
  SPIKE_DID,
  type HoldsBackend,
} from './helpers/enrollment-holds.js'

describe('re-enrolment never lifts a hold on SQLite', () => {
  let tmp: string
  let db: ServiceDb
  let backend: HoldsBackend

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stratos-reenrol-holds-'))
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

  async function holdByOperator(did: string) {
    await seedMember(backend, { did })
    await buildSetActiveHarness(backend).setActive(did, false)
  }

  it('denies the callback for an operator-held member and writes nothing', async () => {
    const harness = buildCallbackHarness(backend)
    await holdByOperator(SPIKE_DID)
    const before = await rowOf(backend, SPIKE_DID)

    const res = await harness.complete(SPIKE_DID)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
    expect(await rowOf(backend, SPIKE_DID)).toEqual(before)
    expect(before?.operatorHold).toBe(true)
    expectNothingProvisioned(harness)
  })

  defineCallbackHoldScenarios(() => backend)

  it('still enrolls a fresh DID as active', async () => {
    const harness = buildCallbackHarness(backend)

    const res = await harness.complete(ED_DID)

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, enrolled: true, did: ED_DID }),
    )
    const row = await rowOf(backend, ED_DID)
    expect(row?.active).toBe(true)
    expect(row?.operatorHold).toBe(false)
    expect(harness.createSigningKey).toHaveBeenCalledWith(ED_DID)
  })

  it('keeps an inactive row inactive when the service enrolls it', async () => {
    await seedMember(backend, { did: JET_DID, active: false })
    const service = new EnrollmentServiceImpl(
      backend.enrollmentStore,
      async () => {},
      async () => {},
    )

    const enrollment = await service.enroll(
      JET_DID,
      [RESERVED_BOUNDARY],
      'did:key:zDnaeBebop',
    )

    expect(enrollment.active).toBe(false)
    expect((await rowOf(backend, JET_DID))?.active).toBe(false)
  })

  it('enrolls a fresh DID as active when the service enrolls it', async () => {
    const service = new EnrollmentServiceImpl(
      backend.enrollmentStore,
      async () => {},
      async () => {},
    )

    const enrollment = await service.enroll(
      ED_DID,
      [RESERVED_BOUNDARY],
      'did:key:zDnaeBebop',
    )

    expect(enrollment.active).toBe(true)
    expect((await rowOf(backend, ED_DID))?.active).toBe(true)
  })

  describe('revoke', () => {
    it('refuses an operator-held member and leaves the row, boundaries and session', async () => {
      const harness = buildCallbackHarness(backend)
      await holdByOperator(SPIKE_DID)
      const before = await rowOf(backend, SPIKE_DID)

      const res = await harness.revokeAs(SPIKE_DID)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
      expect(await rowOf(backend, SPIKE_DID)).toEqual(before)
      expect(before?.boundaries.length).toBeGreaterThan(0)
      expect(harness.oauthClient.restore).not.toHaveBeenCalled()
      expect(harness.oauthClient.revoke).not.toHaveBeenCalled()
    })

    it('still removes an active member', async () => {
      const harness = buildCallbackHarness(backend)
      await seedMember(backend, { did: FAYE_DID })

      const res = await harness.revokeAs(FAYE_DID)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ did: FAYE_DID, revoked: true }),
      )
      expect(await rowOf(backend, FAYE_DID)).toBeNull()
      expect(harness.oauthClient.revoke).toHaveBeenCalledWith(FAYE_DID)
    })

    it('keeps the member held when they complete the callback after a refused revoke', async () => {
      const harness = buildCallbackHarness(backend)
      await holdByOperator(SPIKE_DID)
      await harness.revokeAs(SPIKE_DID)

      const res = await harness.complete(SPIKE_DID)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith(ENROLLMENT_DENIED_BODY)
      const row = await rowOf(backend, SPIKE_DID)
      expect(row?.active).toBe(false)
      expect(row?.operatorHold).toBe(true)
      expectNothingProvisioned(harness)
    })
  })
})
