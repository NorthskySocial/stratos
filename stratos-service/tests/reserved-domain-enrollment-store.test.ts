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

  it('unions the reserved domain on reads for pre-decorator enrollments', async () => {
    // Simulate an enrollment persisted BEFORE the decorator existed (or before
    // the reserved domain was configured) by writing through the raw store.
    const raw = new SqliteEnrollmentStore(db)
    await raw.enroll({
      did: DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:z6Mk',
      boundaries: [ENG],
    })
    // The decorated read still reports the reserved domain without any write.
    expect(await boundaries()).toEqual([ENG, RESERVED].sort())
    // getEnrollment passes through untouched when the backend stores
    // boundaries separately (no boundaries field on the record).
    const record = await store.getEnrollment(DID)
    expect(record).not.toBeNull()
    expect(record?.boundaries).toBeUndefined()
    // The raw store is untouched (read-side union, not a write-back).
    expect((await raw.getBoundaries(DID)).sort()).toEqual([ENG])
  })

  it('listEnrollmentsByBoundary passes through unchanged for a non-reserved boundary', async () => {
    const shinji = 'did:plc:shinji'
    await store.enroll({
      did: DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:z6Mk',
      boundaries: [ENG],
    })
    await store.enroll({
      did: shinji,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:z6Mk',
      boundaries: [OPS],
    })

    const members = await store.listEnrollmentsByBoundary(ENG)
    expect(members.map((m) => m.did)).toEqual([DID])
  })

  it('listEnrollmentsByBoundary for the reserved domain enumerates every active enrollment, including a pre-decorator row never backfilled with it', async () => {
    // Written through the raw store, so its persisted `enrollment_boundary`
    // rows never got the reserved domain -- the same pre-decorator gap
    // `getBoundaries` unions over.
    const raw = new SqliteEnrollmentStore(db)
    await raw.enroll({
      did: DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:z6Mk',
      boundaries: [ENG],
    })

    const inactive = 'did:plc:kaworu'
    await raw.enroll({
      did: inactive,
      enrolledAt: new Date().toISOString(),
      active: false,
      signingKeyDid: 'did:key:z6Mk',
      boundaries: [ENG],
    })

    const members = await store.listEnrollmentsByBoundary(RESERVED)
    const dids = members.map((m) => m.did)
    expect(dids).toContain(DID)
    expect(dids).not.toContain(inactive)
  })

  it('pages the reserved domain past deactivated members without dropping any active one', async () => {
    // A deactivated row anywhere in the key range must not shorten a page:
    // if `active` were filtered after `LIMIT`, a page containing one would
    // come back short, and the handler reads a short page as the last page.
    const members = [
      'did:plc:nausicaa',
      'did:plc:kiki',
      'did:plc:satsuki',
      'did:plc:ashitaka',
      'did:plc:san',
      'did:plc:chihiro',
    ].sort()
    const deactivated = new Set([members[1], members[3]])

    for (const did of members) {
      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: !deactivated.has(did),
        signingKeyDid: 'did:key:z6Mk',
      })
    }

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listEnrollmentsByBoundary(RESERVED, {
        limit: 2,
        cursor,
      })
      seen.push(...page.map((m) => m.did))
      cursor = page.length === 2 ? page[page.length - 1].did : undefined
    } while (cursor)

    const activeMembers = members.filter((did) => !deactivated.has(did))
    expect(seen.sort()).toEqual(activeMembers)
  })
})
