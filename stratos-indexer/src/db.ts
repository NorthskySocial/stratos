import { Database, BackgroundQueue } from '@atproto/bsky'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { DbConfig, IdentityConfig } from './config.ts'

export function createDatabase(cfg: DbConfig): Database {
  return new Database({
    url: cfg.postgresUrl,
    schema: cfg.schema,
    poolSize: cfg.poolSize,
  })
}

export function createIdResolver(cfg: IdentityConfig): IdResolver {
  return new IdResolver({
    plcUrl: cfg.plcUrl,
    didCache: new MemoryCache(),
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
