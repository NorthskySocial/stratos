import { encode as cborEncode } from '@atcute/cbor'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteDb,
  type FeedgenStore,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import { EnrollmentManager } from '../src/enrollment/index.js'
import { Purger } from '../src/purge/index.js'
import { ServiceStream } from '../src/subscription/index.js'
import type { ResolveEnrollmentsResult } from '../src/upstream/index.js'

/**
 * SWP-13 Task 4 — the committed envelope, proved EVENT-DRIVEN (not TTL).
 *
 * With the feedgen boundary cache TTL pinned to one hour AND a frozen clock that
 * NEVER advances, the TTL can never be the reason a stale entry is dropped. So
 * if a revoked viewer's next boundary lookup reflects the revocation, the ONLY
 * possible cause is the event-driven `EnrollmentManager.invalidate(did)` fired
 * by the service-stream unenroll / boundaries-change consumer. That is exactly
 * what the envelope's "typical ≤ seconds" clause promises.
 */

const VIEWER = 'did:plc:viewer'
const BOUNDARY_A = 'nerv.tokyo.jp/alpha'
const BOUNDARY_B = 'nerv.tokyo.jp/beta'
const ONE_HOUR_MS = 60 * 60 * 1000

// ---- Fake service-stream WebSocket (mirrors service-stream.test.ts) --------

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSED = 3

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState: number = WS_CONNECTING
  binaryType = ''
  onmessage: ((e: { data: Uint8Array | ArrayBuffer }) => void) | null = null
  onerror: ((e: Event & { error?: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  private openListeners: Array<() => void> = []

  constructor() {
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: 'open', cb: () => void): void {
    if (type === 'open') this.openListeners.push(cb)
  }
  close(): void {
    if (this.readyState === WS_CLOSED) return
    this.readyState = WS_CLOSED
    this.onclose?.()
  }
  open(): void {
    this.readyState = WS_OPEN
    for (const cb of this.openListeners) cb()
  }
  send(frame: Uint8Array): void {
    this.onmessage?.({ data: frame })
  }
}

function encodeEnrollmentFrame(body: {
  did: string
  action: 'enroll' | 'unenroll' | 'boundaries'
  boundaries?: string[]
}): Uint8Array {
  const header = cborEncode({ op: 1, t: '#enrollment' })
  const bodyBuf = cborEncode({
    $type: 'zone.stratos.sync.subscribeRecords#enrollment',
    did: body.did,
    action: body.action,
    boundaries: body.boundaries ?? [],
    time: new Date().toISOString(),
  })
  const out = new Uint8Array(header.length + bodyBuf.length)
  out.set(header, 0)
  out.set(bodyBuf, header.length)
  return out
}

// ---- Mutable upstream: revocation flips its resolveEnrollments answer -------

function makeUpstream(initial: ResolveEnrollmentsResult) {
  let current = initial
  const calls: string[] = []
  return {
    calls,
    setResult(next: ResolveEnrollmentsResult) {
      current = next
    },
    client: {
      resolveEnrollments: vi.fn(async (did: string) => {
        calls.push(did)
        return current
      }),
    },
  }
}

// ---- Store fixtures --------------------------------------------------------

const tmpDirs: string[] = []
async function makeStore(): Promise<FeedgenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-envelope-'))
  tmpDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  return new SqliteFeedgenStore(db)
}

function post(did: string, rkey: string, boundaries: string[]) {
  return {
    uri: `at://${did}/zone.stratos.feed.post/${rkey}`,
    did,
    cid: `cid-${rkey}`,
    sortAt: '2026-01-01T00:00:00.000Z',
    indexedAt: '2026-01-01T00:00:00.000Z',
    record: { text: rkey },
    blobRefs: [],
    boundaries,
  }
}

describe('SWP-13 feedgen revocation envelope (event-driven, not TTL)', () => {
  let store: FeedgenStore

  beforeEach(async () => {
    FakeWebSocket.instances = []
    store = await makeStore()
  })

  afterEach(async () => {
    await store.close()
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
    tmpDirs.length = 0
  })

  // Wire the enrollment cache + purger + service-stream exactly as main.ts does,
  // sharing an `applyBoundarySet` between onEnroll and onBoundariesChanged.
  function wire(deps: {
    manager: EnrollmentManager
    configuredBoundaries: Set<string>
  }): ServiceStream {
    const purger = new Purger({ store, enrollmentCache: deps.manager })

    const applyBoundarySet = async (
      did: string,
      boundaries: string[],
    ): Promise<void> => {
      const now = new Date().toISOString()
      const existing = await store.getEnrolledActor(did)
      if (existing) {
        const nextSet = new Set(boundaries)
        const lost = existing.boundaries.filter(
          (b) => deps.configuredBoundaries.has(b) && !nextSet.has(b),
        )
        for (const boundary of lost) {
          await purger.purgeActorBoundary(did, boundary)
        }
      }
      await store.upsertEnrolledActor({
        did,
        boundaries,
        enrolledAt: existing?.enrolledAt ?? now,
        lastSeenAt: now,
      })
      deps.manager.invalidate(did)
    }

    return new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'token',
      },
      {
        onEnroll: (did, boundaries) => applyBoundarySet(did, boundaries),
        onBoundariesChanged: (did, boundaries) =>
          applyBoundarySet(did, boundaries),
        onUnenroll: (did) => purger.purgeActor(did).then(() => undefined),
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )
  }

  it('boundaries-change event invalidates the high-TTL cache before the TTL could ever expire', async () => {
    // Frozen clock: time NEVER advances, so the 1h TTL can never fire.
    const now = () => 0
    const up = makeUpstream({
      did: VIEWER,
      enrolled: true,
      boundaries: [BOUNDARY_A, BOUNDARY_B],
    })
    const mgr = new EnrollmentManager({
      client: up.client,
      ttlMs: ONE_HOUR_MS,
      now,
    })

    const configuredBoundaries = new Set([BOUNDARY_A, BOUNDARY_B])
    const stream = wire({
      manager: mgr,
      configuredBoundaries,
    })

    // Seed feedgen state: viewer enrolled in A+B, with a post in A.
    await store.upsertEnrolledActor({
      did: VIEWER,
      boundaries: [BOUNDARY_A, BOUNDARY_B],
      enrolledAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    })
    await store.upsertPost(post(VIEWER, 'p1', [BOUNDARY_A]))

    // Prime the boundary cache — first upstream call.
    expect(await mgr.getBoundaries(VIEWER)).toEqual([BOUNDARY_A, BOUNDARY_B])
    expect(up.calls).toHaveLength(1)
    // Cache is now warm: a second lookup does NOT hit upstream.
    expect(await mgr.getBoundaries(VIEWER)).toEqual([BOUNDARY_A, BOUNDARY_B])
    expect(up.calls).toHaveLength(1)

    // ---- Revoke boundary A upstream, then deliver the boundaries event. ----
    up.setResult({ did: VIEWER, enrolled: true, boundaries: [BOUNDARY_B] })

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.send(
      encodeEnrollmentFrame({
        did: VIEWER,
        action: 'boundaries',
        boundaries: [BOUNDARY_B],
      }),
    )

    // The event path must (1) evict the cache and (2) drive the SWP-12
    // boundary-shrink purge for the lost boundary A.
    await vi.waitFor(async () => {
      const p = await store.listPostsByBoundary({
        boundary: BOUNDARY_A,
        limit: 10,
      })
      expect(p.posts).toEqual([])
    })

    // Next lookup: because the entry was EVICTED (not because the TTL expired —
    // the clock never moved), it MISSES the cache and re-fetches, now reflecting
    // the revocation. This is a second upstream call proving the cache miss.
    const after = await mgr.getBoundaries(VIEWER)
    expect(after).toEqual([BOUNDARY_B])
    expect(up.calls).toHaveLength(2)

    stream.stop()
  })

  it('unenroll event evicts the high-TTL cache and purges the actor (no TTL wait)', async () => {
    const now = () => 0
    const up = makeUpstream({
      did: VIEWER,
      enrolled: true,
      boundaries: [BOUNDARY_A],
    })
    const mgr = new EnrollmentManager({
      client: up.client,
      ttlMs: ONE_HOUR_MS,
      now,
    })
    const stream = wire({
      manager: mgr,
      configuredBoundaries: new Set([BOUNDARY_A]),
    })

    await store.upsertEnrolledActor({
      did: VIEWER,
      boundaries: [BOUNDARY_A],
      enrolledAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    })
    await store.upsertPost(post(VIEWER, 'p1', [BOUNDARY_A]))

    // Warm the cache.
    expect(await mgr.getBoundaries(VIEWER)).toEqual([BOUNDARY_A])
    expect(up.calls).toHaveLength(1)

    // Revoke fully upstream, then deliver the unenroll frame.
    up.setResult({ did: VIEWER, enrolled: false, boundaries: [] })

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.send(encodeEnrollmentFrame({ did: VIEWER, action: 'unenroll' }))

    // purgeActor removes the enrolled-actor snapshot and the actor's posts...
    await vi.waitFor(async () => {
      expect(await store.getEnrolledActor(VIEWER)).toBeNull()
    })
    const posts = await store.listPostsByBoundary({
      boundary: BOUNDARY_A,
      limit: 10,
    })
    expect(posts.posts).toEqual([])

    // ...and evicts the cache: next lookup misses and re-fetches the revoked
    // (enrolled:false → []) state, despite the frozen 1h TTL.
    expect(await mgr.getBoundaries(VIEWER)).toEqual([])
    expect(up.calls).toHaveLength(2)

    stream.stop()
  })
})
