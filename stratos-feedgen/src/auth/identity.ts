import { IdResolver, MemoryCache } from '@atproto/identity'

import type { FeedgenConfig } from '../config.js'

export const DID_CACHE_STALE_TTL = 5 * 60 * 1000 // 5 minutes
export const DID_CACHE_MAX_TTL = 60 * 60 * 1000 // 1 hour
export const DID_CACHE_SWEEP_INTERVAL = 60 * 1000 // sweep every 60s
export const DID_CACHE_MAX_SIZE = 10_000

/**
 * Construct an `IdResolver` for the feed generator, backed by an in-memory
 * DID cache so the auth hot path does not re-resolve the same issuer on every
 * request. Mirrors the standalone indexer's resolver
 * (`stratos-indexer/src/storage/db.ts`).
 */
export function createIdResolver(cfg: FeedgenConfig): IdResolver {
  const cache = new MemoryCache(DID_CACHE_STALE_TTL, DID_CACHE_MAX_TTL)

  // MemoryCache never evicts expired entries on its own — sweep periodically.
  setInterval(() => {
    const now = Date.now()
    const internalMap = cache.cache
    if (internalMap.size > DID_CACHE_MAX_SIZE) {
      internalMap.clear()
      return
    }
    for (const [did, val] of internalMap) {
      if (now > val.updatedAt + DID_CACHE_MAX_TTL) {
        internalMap.delete(did)
      }
    }
  }, DID_CACHE_SWEEP_INTERVAL)

  return new IdResolver({
    plcUrl: cfg.feedgenPlcUrl,
    didCache: cache,
  })
}
