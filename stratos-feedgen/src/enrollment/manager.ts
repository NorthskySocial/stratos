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

/**
 * Caches viewer boundary memberships with TTL + LRU bounds and single-flight
 * deduplication of concurrent misses.
 *
 * Empty results are cached as `[]` (negative caching) so that DIDs which are
 * not enrolled don't hammer Stratos on every request.
 */
export class EnrollmentManager {
  private readonly client: Pick<UpstreamStratosClient, 'resolveEnrollments'>
  private readonly cache: TtlLru<string, string[]>
  private readonly inflight = new Map<string, Promise<string[]>>()

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
    if (existing !== undefined) return existing

    const fetchPromise = this.fetchAndCache(did)
    this.inflight.set(did, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      this.inflight.delete(did)
    }
  }

  private async fetchAndCache(did: string): Promise<string[]> {
    const result = await this.client.resolveEnrollments(did)
    const boundaries = result.enrolled ? result.boundaries : []
    this.cache.set(did, boundaries)
    return boundaries
  }

  /**
   * Drop the cached boundary set for `did`. Used by the deletion pathway so a
   * viewer whose enrollment changed no longer resolves against stale cached
   * boundaries. Idempotent: invalidating an absent DID is a no-op.
   */
  invalidate(did: string): void {
    this.cache.delete(did)
  }
}
