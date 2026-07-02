import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { ServiceDb } from '../src/db/index.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
} from '../src/db/index.js'
import { SqliteEnrollmentStore } from '../src/context.js'
import {
  EnrollmentBoundaryResolver,
  HydrationServiceImpl,
  mintSpaceCredential,
} from '../src/features/index.js'
import { canAccessRecord } from '@northskysocial/stratos-core'
import type {
  HydrationContext,
  HydrationRequest,
  RecordResolver,
} from '@northskysocial/stratos-core'

/**
 * SWP-13 Task 1 — Stratos live-check assertions.
 *
 * The envelope's first invariant is that revocation is IMMEDIATE on Stratos:
 * every hydration request re-resolves the viewer's live boundary set from the
 * enrollment store, so an unenroll or boundary removal is reflected on the very
 * NEXT request — no restart, no wait, no TTL. These tests assert that invariant
 * against the real hydration path (`HydrationServiceImpl` +
 * `EnrollmentBoundaryResolver` over `SqliteEnrollmentStore`).
 */

const OWNER = 'did:plc:owner'
const VIEWER = 'did:plc:viewer'
const BOUNDARY_A = 'did:web:nerv.tokyo.jp/alpha'
const BOUNDARY_B = 'did:web:nerv.tokyo.jp/beta'

const URI_A = `at://${OWNER}/zone.stratos.feed.post/aaa`
const URI_B = `at://${OWNER}/zone.stratos.feed.post/bbb`

/**
 * A trivial in-memory record resolver: `URI_A` is scoped to boundary A and
 * `URI_B` to boundary B. Boundaries here are fixed on the record; only the
 * VIEWER's membership changes across the test, isolating the live-check.
 */
class FakeRecordResolver implements RecordResolver {
  async getRecord(ownerDid: string, uri: string) {
    const boundaries = uri === URI_A ? [BOUNDARY_A] : [BOUNDARY_B]
    return {
      uri,
      cid: `cid-${uri}`,
      value: { $type: 'zone.stratos.feed.post', text: uri },
      boundaries,
    }
  }

  async getRecords(ownerDid: string, uris: string[]) {
    const map = new Map<
      any,
      {
        uri: string
        cid: string
        value: Record<string, unknown>
        boundaries: string[]
      }
    >()
    for (const uri of uris) {
      const boundaries = uri === URI_A ? [BOUNDARY_A] : [BOUNDARY_B]
      map.set(uri as any, {
        uri,
        cid: `cid-${uri}`,
        value: { $type: 'zone.stratos.feed.post', text: uri },
        boundaries,
      })
    }
    return map
  }
}

describe('SWP-13 Stratos live-check (revocation is immediate)', () => {
  let db: ServiceDb
  let store: SqliteEnrollmentStore
  let hydration: HydrationServiceImpl

  beforeEach(async () => {
    db = createServiceDb(':memory:')
    await migrateServiceDb(db)
    store = new SqliteEnrollmentStore(db)
    // The boundary resolver reads the store LIVE on every getBoundaries call.
    const boundaryResolver = new EnrollmentBoundaryResolver(store)
    hydration = new HydrationServiceImpl(
      new FakeRecordResolver(),
      boundaryResolver,
    )

    await store.enroll({
      did: VIEWER,
      enrolledAt: new Date().toISOString(),
      boundaries: [BOUNDARY_A, BOUNDARY_B],
      signingKeyDid: 'did:key:zViewer',
      active: true,
    })
  })

  afterEach(async () => {
    await closeServiceDb(db)
  })

  // A context with viewerDomains=[] forces the hydration path to RESOLVE the
  // viewer's boundaries from the store live, which is the invariant under test.
  function ctx(): HydrationContext {
    return { viewerDid: VIEWER, viewerDomains: [] }
  }

  function reqs(...uris: string[]): HydrationRequest[] {
    return uris.map((uri) => ({ uri }))
  }

  it('(a) after an unenroll, the NEXT hydration request for that viewer denies', async () => {
    // Before: viewer is enrolled in A, so URI_A hydrates.
    const before = await hydration.hydrateRecords(reqs(URI_A), ctx())
    expect(before.records.map((r) => r.uri)).toEqual([URI_A])
    expect(before.blocked).toEqual([])

    // Revoke: hard unenroll. No restart, no wait.
    await store.unenroll(VIEWER)

    // After: the very next request re-resolves live boundaries (now empty) and
    // denies. This proves no membership answer was cached across the request.
    const after = await hydration.hydrateRecords(reqs(URI_A), ctx())
    expect(after.records).toEqual([])
    expect(after.blocked).toEqual([URI_A])
  })

  it('(b) after a boundary removal, records in that boundary vanish from the next hydration', async () => {
    // Before: viewer sees both A and B records.
    const before = await hydration.hydrateRecords(reqs(URI_A, URI_B), ctx())
    expect(before.records.map((r) => r.uri).sort()).toEqual(
      [URI_A, URI_B].sort(),
    )
    expect(before.blocked).toEqual([])

    // Remove only boundary A from the viewer; they stay enrolled in B.
    await store.removeBoundary(VIEWER, BOUNDARY_A)

    // Next request: A-record is denied, B-record still served.
    const after = await hydration.hydrateRecords(reqs(URI_A, URI_B), ctx())
    expect(after.records.map((r) => r.uri)).toEqual([URI_B])
    expect(after.blocked).toEqual([URI_A])
  })

  it('single-record hydrateRecord path is also live per-request', async () => {
    const before = await hydration.hydrateRecord({ uri: URI_A }, ctx())
    expect(before.status).toBe('success')

    await store.removeBoundary(VIEWER, BOUNDARY_A)

    const after = await hydration.hydrateRecord({ uri: URI_A }, ctx())
    expect(after.status).toBe('blocked')
  })
})

/**
 * SWP-13 Task 1(c) — grep-level guard.
 *
 * No NEW membership cache may sit between the enrollment store and the read-path
 * gates (`canAccessRecord` in the hydration adapter, `eventInScope` in the
 * subscription handler). Both must reach `getBoundaries` on each request/event
 * via the boundary resolver / enrollment store — never a fresh in-memory cache
 * introduced by this WP.
 *
 * The pre-existing `CachedEnrollmentStore` (postgres backend only, 300s TTL) is
 * documented in the SWP-13 Log; it invalidates synchronously on write, so it
 * does not add an in-process staleness window. This guard fails if a new caching
 * layer name is wired into the hydration/subscription read paths.
 */
describe('SWP-13 no-new-cache guard (grep-level)', () => {
  function readSrc(relFromTestDir: string): string {
    const url = new URL(relFromTestDir, import.meta.url)
    return readFileSync(fileURLToPath(url), 'utf8')
  }

  it('hydration adapter resolves boundaries via the injected BoundaryResolver, not a new cache', () => {
    const src = readSrc('../src/features/hydration/adapter.ts')
    // The live resolution call must be present...
    expect(src).toContain('this.boundaryResolver.getBoundaries(')
    // ...and no ad-hoc cache is instantiated in the hydration adapter.
    expect(src).not.toMatch(/new\s+\w*Cache\w*\s*\(/)
    expect(src).not.toMatch(/new\s+Map<[^>]*>\s*\(\s*\)\s*[^]*getBoundaries/)
  })

  it('subscription eventInScope gates on caller boundaries, resolved live per connection', () => {
    const src = readSrc('../src/subscription/subscribe-records.ts')
    // eventInScope only consumes the passed-in boundary set (no cache lookup).
    expect(src).toContain('export function eventInScope(')
    // Caller boundaries come straight from the enrollment store on connect.
    expect(src).toContain('await ctx.enrollmentStore.getBoundaries(callerDid)')
    // No new cache class is instantiated in the subscription read path.
    expect(src).not.toMatch(/new\s+\w*Cache\w*\s*\(/)
  })
})

/**
 * SWP-13 envelope point 3 — space credentials do NOT extend exposure.
 *
 * A space credential (SWP-06) is an out-of-band bearer token that admits API
 * calls; it is NOT an input to the per-record boundary gate. `canAccessRecord`
 * decides purely on the viewer's LIVE `viewerDomains` vs. the record's
 * boundaries, so holding a (still-valid) credential after a viewer's membership
 * is revoked does not grant access.
 *
 * NOTE (SWP-07): the credential *verifier* — the consumer that would accept a
 * credential on an API call and turn it into a session — has not landed in this
 * base (only the SWP-06 minter is present; there is no verifier that maps a
 * credential to `viewerDomains`). The composition asserted here is therefore at
 * the gate level. When SWP-07 lands, extend this to run an actual
 * credential-authenticated hydration request and assert the same denial.
 */
describe('SWP-13 credentials do not extend exposure (composition)', () => {
  const OWNER2 = 'did:plc:owner2'
  const VIEWER2 = 'did:plc:viewer2'
  const SPACE_BOUNDARY = 'did:web:nerv.tokyo.jp/space'
  const SPACE_URI = 'ats://did:web:nerv.tokyo.jp/space/thread'

  it('a still-valid credential does not bypass the per-record boundary gate after revocation', async () => {
    // Prove a real, unexpired space credential exists (SWP-06 minter).
    const key = await Secp256k1Keypair.create()
    const iat = Math.floor(Date.now() / 1000)
    const minted = await mintSpaceCredential({
      signingKey: key,
      issuerDid: 'did:web:stratos.example.com',
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
      iat,
    })
    // Credential is valid well into the future...
    expect(minted.exp).toBeGreaterThan(iat)
    expect(minted.credential.split('.')).toHaveLength(3)

    // ...yet the per-record gate ignores it: it depends only on the viewer's
    // LIVE domains. With the space boundary revoked (viewerDomains no longer
    // contains it), access is denied regardless of the credential.
    const grantedWhileMember = canAccessRecord({
      recordBoundaries: [SPACE_BOUNDARY],
      ownerDid: OWNER2,
      context: { viewerDid: VIEWER2, viewerDomains: [SPACE_BOUNDARY] },
    })
    expect(grantedWhileMember).toBe(true)

    const deniedAfterRevocation = canAccessRecord({
      recordBoundaries: [SPACE_BOUNDARY],
      ownerDid: OWNER2,
      // Membership revoked → empty live domains. Credential still in hand.
      context: { viewerDid: VIEWER2, viewerDomains: [] },
    })
    expect(deniedAfterRevocation).toBe(false)
  })
})
