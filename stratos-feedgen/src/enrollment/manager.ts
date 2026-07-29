import {
  DEFAULT_BOUNDARY_CACHE_MAX,
  DEFAULT_BOUNDARY_CACHE_TTL_MS,
} from '../config.js'
import type { UpstreamStratosClient } from '../upstream/index.js'
import { TtlLru } from './lru.js'

export interface EnrollmentManagerOptions {
  client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  ttlMs?: number
  max?: number
  /** Injectable clock for tests. */
  now?: () => number
}

/** A single in-flight boundary fetch, identified for invalidation racing. */
interface InflightFetch {
  promise: Promise<string[]>
}

/**
 * Caches viewer boundary memberships with TTL + LRU bounds and single-flight
 * deduplication of concurrent misses.
 *
 * Empty results are cached as `[]` (negative caching) so that DIDs which are
 * not enrolled don't hammer Stratos on every request.
 *
 * Revocation racing: {@link invalidate} both drops the cached entry and
 * DETACHES any in-flight fetch (removes it from the single-flight map). The
 * detached fetch still resolves for its original callers, but it can no
 * longer cache its (pre-revocation) result, and lookups arriving after the
 * invalidation start a fresh fetch instead of sharing the stale one. Staleness
 * is tracked by fetch identity - membership in the in-flight map - so state is
 * bounded by the number of concurrent fetches (no per-DID history retained).
 */
export class EnrollmentManager {
  private readonly client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  private readonly cache: TtlLru<string, string[]>
  private readonly inflight = new Map<string, InflightFetch>()

  constructor(opts: EnrollmentManagerOptions) {
    this.client = opts.client
    this.cache = new TtlLru<string, string[]>({
      ttlMs: opts.ttlMs ?? DEFAULT_BOUNDARY_CACHE_TTL_MS,
      max: opts.max ?? DEFAULT_BOUNDARY_CACHE_MAX,
      now: opts.now,
    })
  }

  async getBoundaries(did: string): Promise<string[]> {
    const cached = this.cache.get(did)
    if (cached !== undefined) return cached

    const existing = this.inflight.get(did)
    if (existing !== undefined) return existing.promise

    const entry: InflightFetch = { promise: undefined as never }
    entry.promise = this.fetchAndCache(did, entry)
    this.inflight.set(did, entry)
    try {
      return await entry.promise
    } finally {
      // Identity-conditional cleanup: an invalidation may have detached this
      // entry and a replacement fetch may already occupy the slot - deleting
      // unconditionally would tear down the replacement's single-flighting.
      if (this.inflight.get(did) === entry) {
        this.inflight.delete(did)
      }
    }
  }

  private async fetchAndCache(
    did: string,
    entry: InflightFetch,
  ): Promise<string[]> {
    const result = await this.client.resolveEnrollments(did)
    const boundaries = result.enrolled ? result.boundaries : []
    // Only cache while still the CURRENT fetch for this DID. An invalidation
    // detaches the entry, so a resolve that raced a revocation cannot
    // re-populate the cache with the stale (over-privileged) set for a TTL.
    if (this.inflight.get(did) === entry) {
      this.cache.set(did, boundaries)
    }
    return boundaries
  }

  /**
   * Drop the cached boundary set for `did` and detach any in-flight fetch.
   * Used by the deletion pathway so a viewer whose enrollment changed no
   * longer resolves against stale cached boundaries: post-invalidation
   * lookups re-fetch instead of joining the pre-revocation fetch, and the
   * detached fetch can no longer write to the cache. Idempotent: invalidating
   * an absent DID is a no-op.
   */
  invalidate(did: string): void {
    this.cache.delete(did)
    this.inflight.delete(did)
  }
}
