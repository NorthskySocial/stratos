import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PARENT_BOUNDARY_CACHE_MAX,
  resolveParentBoundaries,
} from '../src/api/records/validation.js'
import type { AppContext } from '../src/context.js'

function replyRecord(parentUri: string): Record<string, unknown> {
  return { reply: { parent: { uri: parentUri } } }
}

/**
 * A minimal fake ctx whose actorStore.read counts invocations and resolves
 * a parent record with no boundaries — resolveParentBoundaries only cares
 * about the read count here, not the boundary values.
 */
function fakeCtx(): { ctx: AppContext; readCount: () => number } {
  let count = 0
  const store = {
    record: {
      getRecord: vi.fn(async () => ({
        uri: 'unused',
        cid: 'unused',
        value: {},
        indexedAt: new Date().toISOString(),
        takedownRef: null,
      })),
    },
  }
  const ctx = {
    actorStore: {
      read: vi.fn(async (_did: string, fn: (s: typeof store) => unknown) => {
        count++
        return fn(store)
      }),
    },
  } as unknown as AppContext
  return { ctx, readCount: () => count }
}

describe('resolveParentBoundaries cache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves a repeat lookup for the same parent from cache within the TTL', async () => {
    const parentUri = 'at://did:plc:asuka/zone.stratos.feed.post/reply-ttl-1'
    const { ctx, readCount } = fakeCtx()

    await resolveParentBoundaries(ctx, replyRecord(parentUri))
    await resolveParentBoundaries(ctx, replyRecord(parentUri))

    expect(readCount()).toBe(1)
  })

  it('deletes an expired entry rather than skipping it, forcing a re-read', async () => {
    vi.useFakeTimers()
    const parentUri = 'at://did:plc:shinji/zone.stratos.feed.post/reply-ttl-2'
    const { ctx, readCount } = fakeCtx()

    await resolveParentBoundaries(ctx, replyRecord(parentUri))
    // Advance exactly to the TTL boundary: entries this old must be treated
    // as expired (a `<=` off-by-one here would keep serving from cache).
    vi.advanceTimersByTime(60_000)
    await resolveParentBoundaries(ctx, replyRecord(parentUri))

    expect(readCount()).toBe(2)
  })

  it('evicts the oldest entry once the cache exceeds its size cap', async () => {
    const firstUri = 'at://did:plc:misato/zone.stratos.feed.post/reply-cap-0'
    const otherUri = (i: number) =>
      `at://did:plc:misato/zone.stratos.feed.post/reply-cap-${i}`
    const { ctx, readCount } = fakeCtx()

    await resolveParentBoundaries(ctx, replyRecord(firstUri))
    expect(readCount()).toBe(1)

    // Fill up to exactly the cap (first entry + MAX-1 more) without
    // disturbing the first entry — the guard must not evict below the cap.
    for (let i = 1; i < PARENT_BOUNDARY_CACHE_MAX; i++) {
      await resolveParentBoundaries(ctx, replyRecord(otherUri(i)))
    }
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX)

    await resolveParentBoundaries(ctx, replyRecord(firstUri))
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX) // still a hit, not yet evicted

    // One more distinct entry pushes size to the cap before insert, tripping
    // the guard and evicting the oldest entry (the first URI).
    await resolveParentBoundaries(
      ctx,
      replyRecord(otherUri(PARENT_BOUNDARY_CACHE_MAX)),
    )
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX + 1)

    await resolveParentBoundaries(ctx, replyRecord(firstUri))
    expect(readCount()).toBe(PARENT_BOUNDARY_CACHE_MAX + 2) // evicted, re-fetched
  })
})
