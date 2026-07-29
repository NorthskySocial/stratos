import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BOUNDARY_CACHE_MAX,
  DEFAULT_BOUNDARY_CACHE_TTL_MS,
} from '../src/config.js'
import { EnrollmentManager } from '../src/enrollment/manager.js'
import { TtlLru } from '../src/enrollment/lru.js'
import type { ResolveEnrollmentsResult } from '../src/upstream/index.js'

// Mock clock used by both the LRU and tests so we can drive expiry without
// relying on real timers.
function makeClock(initial = 0) {
  let now = initial
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    set: (ms: number) => {
      now = ms
    },
  }
}

function makeClient(impl: (did: string) => ResolveEnrollmentsResult) {
  return {
    resolveEnrollments: vi.fn(async (did: string) => impl(did)),
  }
}

const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'
const VASH = 'did:plc:vashstampede'
const SHINJI = 'did:plc:shinjiikari'

describe('EnrollmentManager', () => {
  describe('default options', () => {
    it('exposes 300_000 ms TTL and 10_000 entry max', () => {
      expect(DEFAULT_BOUNDARY_CACHE_TTL_MS).toBe(300_000)
      expect(DEFAULT_BOUNDARY_CACHE_MAX).toBe(10_000)
    })
  })

  describe('cache hit path', () => {
    it('returns cached value without invoking the client', async () => {
      const client = makeClient(() => ({
        did: SPIKE,
        enrolled: true,
        boundaries: ['cowboybebop.tv/crew'],
      }))
      const mgr = new EnrollmentManager({ client })

      expect(await mgr.getBoundaries(SPIKE)).toEqual(['cowboybebop.tv/crew'])
      expect(await mgr.getBoundaries(SPIKE)).toEqual(['cowboybebop.tv/crew'])
      expect(await mgr.getBoundaries(SPIKE)).toEqual(['cowboybebop.tv/crew'])

      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)
    })
  })

  describe('expiry', () => {
    it('refreshes after the TTL elapses', async () => {
      const clock = makeClock()
      const client = makeClient((did) => ({
        did,
        enrolled: true,
        boundaries: ['trigun.tv/insurance'],
      }))
      const mgr = new EnrollmentManager({
        client,
        ttlMs: 1_000,
        now: clock.now,
      })

      await mgr.getBoundaries(VASH)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)

      clock.advance(500)
      await mgr.getBoundaries(VASH)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)

      clock.advance(600) // past 1000 ms TTL
      await mgr.getBoundaries(VASH)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)
    })
  })

  describe('negative caching', () => {
    it('caches empty boundary list when enrolled=false', async () => {
      const client = makeClient((did) => ({
        did,
        enrolled: false,
        boundaries: [],
      }))
      const mgr = new EnrollmentManager({ client })

      expect(await mgr.getBoundaries(SHINJI)).toEqual([])
      expect(await mgr.getBoundaries(SHINJI)).toEqual([])
      expect(await mgr.getBoundaries(SHINJI)).toEqual([])

      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)
    })
  })

  describe('single-flight', () => {
    it('coalesces concurrent misses for the same DID', async () => {
      let resolveCall: (value: ResolveEnrollmentsResult) => void = () => {}
      const pending = new Promise<ResolveEnrollmentsResult>((resolve) => {
        resolveCall = resolve
      })
      const client = {
        resolveEnrollments: vi.fn(async () => pending),
      }
      const mgr = new EnrollmentManager({ client })

      const p1 = mgr.getBoundaries(FAYE)
      const p2 = mgr.getBoundaries(FAYE)
      const p3 = mgr.getBoundaries(FAYE)

      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)

      resolveCall({
        did: FAYE,
        enrolled: true,
        boundaries: ['cowboybebop.tv/bounty'],
      })

      const results = await Promise.all([p1, p2, p3])
      expect(results).toEqual([
        ['cowboybebop.tv/bounty'],
        ['cowboybebop.tv/bounty'],
        ['cowboybebop.tv/bounty'],
      ])
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)
    })

    it('releases the inflight slot after settle so failures can retry', async () => {
      let attempt = 0
      const client = {
        resolveEnrollments: vi.fn(async (did: string) => {
          attempt += 1
          if (attempt === 1) throw new Error('boom')
          return { did, enrolled: true, boundaries: ['gundam.tv/pilots'] }
        }),
      }
      const mgr = new EnrollmentManager({ client })

      await expect(mgr.getBoundaries(SHINJI)).rejects.toThrow('boom')
      expect(await mgr.getBoundaries(SHINJI)).toEqual(['gundam.tv/pilots'])
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)
    })
  })

  describe('invalidate vs in-flight fetch race', () => {
    it('does not re-cache a result fetched before the invalidation', async () => {
      let resolveCall: (value: ResolveEnrollmentsResult) => void = () => {}
      const pending = new Promise<ResolveEnrollmentsResult>((resolve) => {
        resolveCall = resolve
      })
      const client = {
        resolveEnrollments: vi.fn(async () => pending),
      }
      const mgr = new EnrollmentManager({ client })

      // A resolve starts (pre-revocation boundary set still upstream) ...
      const inflight = mgr.getBoundaries(SPIKE)
      // ... the revocation lands and invalidates ...
      mgr.invalidate(SPIKE)
      // ... then the stale fetch completes.
      resolveCall({
        did: SPIKE,
        enrolled: true,
        boundaries: ['cowboybebop.tv/bounty'],
      })
      // The raced caller still gets the value it fetched ...
      expect(await inflight).toEqual(['cowboybebop.tv/bounty'])

      // ... but the cache was NOT repopulated with it: the next lookup goes
      // back upstream instead of serving the pre-revocation set for a TTL.
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)
      void mgr.getBoundaries(SPIKE)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)
    })

    it('still caches normally when no invalidation raced the fetch', async () => {
      const client = makeClient((did) => ({
        did,
        enrolled: true,
        boundaries: ['anime.tv/season'],
      }))
      const mgr = new EnrollmentManager({ client })

      mgr.invalidate(VASH)
      expect(await mgr.getBoundaries(VASH)).toEqual(['anime.tv/season'])
      expect(await mgr.getBoundaries(VASH)).toEqual(['anime.tv/season'])
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(1)
    })

    it('lookups after invalidation do NOT join the pre-revocation fetch', async () => {
      // Pre-revocation resolve hangs; post-invalidation resolve is fresh.
      let resolveStale: (value: ResolveEnrollmentsResult) => void = () => {}
      const staleFetch = new Promise<ResolveEnrollmentsResult>((resolve) => {
        resolveStale = resolve
      })
      let call = 0
      const client = {
        resolveEnrollments: vi.fn(async (did: string) => {
          call += 1
          if (call === 1) return staleFetch
          return { did, enrolled: true, boundaries: ['fresh'] }
        }),
      }
      const mgr = new EnrollmentManager({ client })

      const stale = mgr.getBoundaries(SPIKE)
      mgr.invalidate(SPIKE)

      // A lookup arriving AFTER the revocation must not share the stale
      // in-flight promise - it starts a fresh resolve.
      const fresh = await mgr.getBoundaries(SPIKE)
      expect(fresh).toEqual(['fresh'])
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)

      // The stale fetch settling later neither disturbs the fresh cache
      // entry nor re-caches its own result.
      resolveStale({
        did: SPIKE,
        enrolled: true,
        boundaries: ['stale'],
      })
      expect(await stale).toEqual(['stale'])
      expect(await mgr.getBoundaries(SPIKE)).toEqual(['fresh'])
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)
    })

    it("a detached fetch's cleanup does not tear down its replacement", async () => {
      // Hold BOTH fetches open, settle the detached one first, and verify the
      // replacement still single-flights (its inflight slot survived).
      const resolvers: Array<(value: ResolveEnrollmentsResult) => void> = []
      const client = {
        resolveEnrollments: vi.fn(
          () =>
            new Promise<ResolveEnrollmentsResult>((resolve) => {
              resolvers.push(resolve)
            }),
        ),
      }
      const mgr = new EnrollmentManager({ client })

      const stale = mgr.getBoundaries(SPIKE)
      mgr.invalidate(SPIKE)
      const fresh = mgr.getBoundaries(SPIKE)

      // Settle the detached (stale) fetch; its finally must NOT delete the
      // replacement's inflight entry.
      resolvers[0]({ did: SPIKE, enrolled: true, boundaries: ['stale'] })
      await stale

      // Joining now must share the replacement fetch, not start a third.
      const joined = mgr.getBoundaries(SPIKE)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)

      resolvers[1]({ did: SPIKE, enrolled: true, boundaries: ['fresh'] })
      expect(await fresh).toEqual(['fresh'])
      expect(await joined).toEqual(['fresh'])
    })
  })

  describe('LRU eviction', () => {
    it('evicts the oldest entry when max is exceeded', async () => {
      const client = makeClient((did) => ({
        did,
        enrolled: true,
        boundaries: [`tv/${did}`],
      }))
      const mgr = new EnrollmentManager({ client, max: 2 })

      await mgr.getBoundaries(SPIKE) // 1 upstream call
      await mgr.getBoundaries(FAYE) // 2
      await mgr.getBoundaries(VASH) // 3 — evicts SPIKE

      // FAYE + VASH should still be cached
      await mgr.getBoundaries(FAYE)
      await mgr.getBoundaries(VASH)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(3)

      // SPIKE was evicted, this triggers a fresh fetch
      await mgr.getBoundaries(SPIKE)
      expect(client.resolveEnrollments).toHaveBeenCalledTimes(4)
    })
  })

  describe('configuration', () => {
    it('honors a non-default TTL', async () => {
      const clock = makeClock()
      const client = makeClient((did) => ({
        did,
        enrolled: true,
        boundaries: ['evangelion.tv/nerv'],
      }))
      const mgr = new EnrollmentManager({
        client,
        ttlMs: 50,
        now: clock.now,
      })

      await mgr.getBoundaries(SHINJI)
      clock.advance(60) // past 50 ms
      await mgr.getBoundaries(SHINJI)

      expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)
    })

    it('honors a non-default max', async () => {
      const client = makeClient((did) => ({
        did,
        enrolled: true,
        boundaries: ['anime.tv/season'],
      }))
      const mgr = new EnrollmentManager({ client, max: 1 })

      await mgr.getBoundaries(SPIKE)
      await mgr.getBoundaries(FAYE) // evicts SPIKE
      await mgr.getBoundaries(SPIKE) // miss again

      expect(client.resolveEnrollments).toHaveBeenCalledTimes(3)
    })
  })
})

describe('TtlLru', () => {
  it('rejects non-positive ttl or max', () => {
    expect(() => new TtlLru({ ttlMs: 0, max: 1 })).toThrow()
    expect(() => new TtlLru({ ttlMs: 1, max: 0 })).toThrow()
  })

  it('promotes entries to most-recent on read', () => {
    const clock = makeClock()
    const lru = new TtlLru<string, number>({
      ttlMs: 10_000,
      max: 2,
      now: clock.now,
    })
    lru.set('a', 1)
    lru.set('b', 2)
    // touch 'a' to make it most-recent
    expect(lru.get('a')).toBe(1)
    // inserting 'c' should evict 'b' (least-recent), not 'a'
    lru.set('c', 3)
    expect(lru.get('a')).toBe(1)
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('c')).toBe(3)
  })

  it('treats expired entries as missing and removes them', () => {
    const clock = makeClock()
    const lru = new TtlLru<string, string>({
      ttlMs: 100,
      max: 10,
      now: clock.now,
    })
    lru.set('a', 'hi')
    clock.advance(150)
    expect(lru.get('a')).toBeUndefined()
    expect(lru.size).toBe(0)
  })
})
