import { IdResolver, MemoryCache } from '@atproto/identity'
import type { DidDocument } from '@atproto/identity'

import type { FeedgenConfig } from '../config.js'

export const DID_CACHE_STALE_TTL = 5 * 60 * 1000 // 5 minutes
export const DID_CACHE_MAX_TTL = 60 * 60 * 1000 // 1 hour
export const DID_CACHE_SWEEP_INTERVAL = 60 * 1000 // sweep every 60s
export const DID_CACHE_MAX_SIZE = 10_000

/**
 * A `MemoryCache` that holds its size limit at every write.
 *
 * `MemoryCache.cacheDid` writes straight to its `Map`, so a limit applied only
 * by the periodic sweep lets a burst of distinct issuers grow the cache past
 * the limit until the next sweep. Evicting on write keeps the bound true at
 * all times, and it discards the least recently written entry instead of
 * dropping every entry at once.
 */
export class BoundedDidCache extends MemoryCache {
  constructor(
    staleTTL: number,
    maxTTL: number,
    private readonly maxSize: number,
  ) {
    super(staleTTL, maxTTL)
  }

  override async cacheDid(did: string, doc: DidDocument): Promise<void> {
    // Delete first so a refresh moves the entry to the end of the insertion
    // order. The first key is then always the least recently written one.
    this.cache.delete(did)
    await super.cacheDid(did, doc)
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }
}

/**
 * Construct an `IdResolver` for the feed generator, backed by an in-memory
 * DID cache so the auth hot path does not re-resolve the same issuer on every
 * request.
 */
export function createIdResolver(cfg: FeedgenConfig): IdResolver {
  const cache = new BoundedDidCache(
    DID_CACHE_STALE_TTL,
    DID_CACHE_MAX_TTL,
    DID_CACHE_MAX_SIZE,
  )

  // MemoryCache never evicts expired entries on its own — sweep periodically.
  setInterval(() => {
    const now = Date.now()
    for (const [did, val] of cache.cache) {
      if (now > val.updatedAt + DID_CACHE_MAX_TTL) {
        cache.cache.delete(did)
      }
    }
  }, DID_CACHE_SWEEP_INTERVAL)

  return new IdResolver({
    plcUrl: cfg.feedgenPlcUrl,
    didCache: cache,
  })
}
