import { sql, Kysely } from 'kysely'
import { BackgroundQueue, Database } from '@atproto/bsky'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import PQueue from 'p-queue'
import type { DbConfig, IdentityConfig, IndexerConfig } from './config.ts'

const DID_CACHE_STALE_TTL = 5 * 60 * 1000 // 5 minutes
const DID_CACHE_MAX_TTL = 60 * 60 * 1000 // 1 hour
const DID_CACHE_SWEEP_INTERVAL = 60 * 1000 // sweep every 60s
const DID_CACHE_MAX_SIZE = 10_000

/**
 * Create a new database instance with the given configuration.
 *
 * @param cfg - Database configuration.
 * @returns A new Database instance.
 */
export function createDatabase(cfg: DbConfig): Database {
  const db = new Database({
    url: cfg.postgresUrl,
    schema: cfg.schema,
    poolSize: cfg.poolSize,
  })

  // Ensure optimized indexes for Stratos-specific hydration and sync patterns
  // Note: These are added to the PostgreSQL bsky schema
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      const rawDb = (db as any).db as Kysely<Record<string, unknown>>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await rawDb.execute(sql`
        CREATE TABLE IF NOT EXISTS stratos_enrollment (
          did TEXT PRIMARY KEY,
          serviceUrl TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await rawDb.execute(sql`
        CREATE TABLE IF NOT EXISTS stratos_boundary (
          did TEXT NOT NULL,
          boundary TEXT NOT NULL,
          PRIMARY KEY (did, boundary)
        )
      `)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await rawDb.execute(sql`
        CREATE TABLE IF NOT EXISTS stratos_sync_cursor (
          did TEXT PRIMARY KEY,
          seq INTEGER NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `)
      // Optimized index for boundary-based hydration
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await rawDb.execute(sql`
        CREATE INDEX IF NOT EXISTS stratos_post_boundary_idx 
        ON stratos_post (boundary)
      `)
      // Optimized index for actor-based feed queries
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await rawDb.execute(sql`
        CREATE INDEX IF NOT EXISTS stratos_post_did_indexed_at_idx 
        ON stratos_post (did, indexedAt DESC)
      `)
    } catch (err) {
      console.error(
        { err },
        'failed to initialize stratos indexer tables/indexes',
      )
    }
  })()

  return db
}

/**
 * Create a new ID resolver instance with the given configuration.
 *
 * @param cfg - Identity configuration.
 * @returns A new IdResolver instance.
 */
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

/**
 * Cap the size of a background queue by limiting concurrency and maximum size.
 *
 * @param background - The background queue to cap.
 * @param concurrency - Maximum number of concurrent tasks.
 * @param maxSize - Maximum total number of tasks in the queue.
 */
function capBackgroundQueue(
  background: BackgroundQueue,
  concurrency: number,
  maxSize: number,
): void {
  const limited = new PQueue({ concurrency })
  ;(background as unknown as { queue: PQueue }).queue = limited

  const originalAdd = background.add.bind(background)
  background.add = (task) => {
    if (limited.size + limited.pending >= maxSize) return
    originalAdd(task)
  }
}

/**
 * Create an indexing service with the given database, ID resolver, and configuration.
 *
 * @param db - Database instance for indexing operations.
 * @param idResolver - ID resolver for resolving DIDs.
 * @param config - Configuration for the indexing service.
 * @returns A tuple containing the indexing service and the background queue.
 */
export function createIndexingService(
  db: Database,
  idResolver: IdResolver,
  config: IndexerConfig,
): { indexingService: IndexingService; background: BackgroundQueue } {
  const background = new BackgroundQueue(db)
  capBackgroundQueue(
    background,
    config.worker.backgroundQueueConcurrency,
    config.worker.backgroundQueueMaxSize,
  )
  const indexingService = new IndexingService(db, idResolver, background)
  return { indexingService, background }
}
