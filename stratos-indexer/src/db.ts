import { Database, BackgroundQueue } from '@atproto/bsky'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { DbConfig, IdentityConfig } from './config.ts'

const DID_CACHE_STALE_TTL = 5 * 60 * 1000   // 5 minutes
const DID_CACHE_MAX_TTL = 60 * 60 * 1000     // 1 hour
const DID_CACHE_SWEEP_INTERVAL = 60 * 1000   // sweep every 60s
const DID_CACHE_MAX_SIZE = 50_000

export function createDatabase(cfg: DbConfig): Database {
  return new Database({
    url: cfg.postgresUrl,
    schema: cfg.schema,
    poolSize: cfg.poolSize,
  })
}

export function createIdResolver(cfg: IdentityConfig): IdResolver {
  const cache = new MemoryCache(DID_CACHE_STALE_TTL, DID_CACHE_MAX_TTL)

  // MemoryCache never evicts expired entries on its own — sweep periodically
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
    plcUrl: cfg.plcUrl,
    didCache: cache,
  })
}

export function createIndexingService(
  db: Database,
  idResolver: IdResolver,
): { indexingService: IndexingService; background: BackgroundQueue } {
  const background = new BackgroundQueue(db)
  const indexingService = new IndexingService(db, idResolver, background)
  return { indexingService, background }
}
