/**
 * Reserved-domain force-inclusion.
 *
 * The reserved all-members domain is force-included in every enrollment write
 * (user OAuth enrollment, service reconciler, admin edits) and cannot be
 * removed by a boundary update. This decorator is the single chokepoint, so
 * these tests exercise every write method against a real SQLite store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteEnrollmentStore } from '../src/context.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import {
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'

const RESERVED = 'did:web:host/general'
const ENG = 'did:web:host/eng'
const OPS = 'did:web:host/ops'
const DID = 'did:plc:asuka'

describe('ReservedDomainEnrollmentStore', () => {
  let tmp: string
  let db: ServiceDb
  let store: ReservedDomainEnrollmentStore

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stratos-reserved-'))
    db = createServiceDb(join(tmp, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new ReservedDomainEnrollmentStore(
      new SqliteEnrollmentStore(db),
      RESERVED,
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function boundaries(): Promise<string[]> {
    return (await store.getBoundaries(DID)).sort()
  }

  it('force-includes the reserved domain on enroll', async () => {
    await store.enroll({
      did: DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:z6Mk',
      boundaries: [ENG],
    })
    expect(await boundaries()).toEqual([ENG, RESERVED].sort())
  })

  it('force-includes the reserved domain even when enroll has no boundaries', async () => {
    await store.enroll({
      did: DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:z6Mk',
    })
    expect(await boundaries()).toEqual([RESERVED])
  })

  it('force-includes the reserved domain on setBoundaries', async () => {
    await store.setBoundaries(DID, [ENG, OPS])
    expect(await boundaries()).toEqual([ENG, OPS, RESERVED].sort())
  })

  it('does not duplicate the reserved domain when already present', async () => {
    await store.setBoundaries(DID, [ENG, RESERVED])
    expect(await boundaries()).toEqual([ENG, RESERVED].sort())
  })

  it('silently ignores an attempt to remove the reserved domain', async () => {
    await store.setBoundaries(DID, [ENG, OPS])
    await store.removeBoundary(DID, RESERVED)
    expect(await boundaries()).toEqual([ENG, OPS, RESERVED].sort())
  })

  it('still removes a non-reserved boundary', async () => {
    await store.setBoundaries(DID, [ENG, OPS])
    await store.removeBoundary(DID, OPS)
    expect(await boundaries()).toEqual([ENG, RESERVED].sort())
  })

  it('addBoundary passes through', async () => {
    await store.setBoundaries(DID, [ENG])
    await store.addBoundary(DID, OPS)
    expect(await boundaries()).toEqual([ENG, OPS, RESERVED].sort())
  })
})
