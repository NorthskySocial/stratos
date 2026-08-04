import { sql, Kysely } from 'kysely'
import { BackgroundQueue, Database } from '@atproto/bsky'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import PQueue from 'p-queue'
import type { DbConfig, IdentityConfig, IndexerConfig } from '../config.js'

const DID_CACHE_STALE_TTL = 5 * 60 * 1000 // 5 minutes
const DID_CACHE_MAX_TTL = 60 * 60 * 1000 // 1 hour
const DID_CACHE_SWEEP_INTERVAL = 60 * 1000 // sweep every 60s
const DID_CACHE_MAX_SIZE = 10_000

/**
 * Columns created by pre-quoting builds of this file, which declared them
 * unquoted and so had Postgres fold them to lower case. Kysely emits quoted
 * camelCase, so those tables must be renamed forward or every write fails.
 */
const LEGACY_LOWERCASE_COLUMNS = [
  { table: 'stratos_enrollment', from: 'serviceurl', to: 'serviceUrl' },
  { table: 'stratos_enrollment', from: 'createdat', to: 'createdAt' },
  { table: 'stratos_enrollment', from: 'updatedat', to: 'updatedAt' },
  { table: 'stratos_sync_cursor', from: 'updatedat', to: 'updatedAt' },
  { table: 'stratos_record', from: 'indexedat', to: 'indexedAt' },
] as const

/**
 * Create a new database instance with the given configuration.
 *
 * @param cfg - Database configuration.
 * @returns A new Database instance.
 */
export function createDatabase(cfg: DbConfig): Database {
  return new Database({
    url: cfg.postgresUrl,
    schema: cfg.schema,
    poolSize: cfg.poolSize,
  })
}

/**
 * Rename a legacy lower-cased column to its camelCase form. No-ops when the
 * table is absent, already renamed, or freshly created, so it is safe to rerun.
 *
 * @param db - Raw kysely instance.
 * @param table - Table holding the column.
 * @param from - Existing lower-cased column name.
 * @param to - Target camelCase column name.
 */
async function renameLegacyColumn(
  db: Kysely<Record<string, unknown>>,
  table: string,
  from: string,
  to: string,
): Promise<void> {
  const { rows } = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name IN (${from}, ${to})
  `.execute(db)

  const present = new Set(rows.map((row) => row.column_name))
  if (!present.has(from) || present.has(to)) return

  await sql`
    ALTER TABLE ${sql.table(table)}
    RENAME COLUMN ${sql.id(from)} TO ${sql.id(to)}
  `.execute(db)
}

/**
 * Create the indexer's tables and indexes, and repair legacy column casing.
 * Must complete before any indexing write runs.
 *
 * @param db - Database instance to initialize.
 */
export async function ensureIndexerSchema(db: Database): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const rawDb = (db as any).db as Kysely<Record<string, unknown>>
    // Postgres folds unquoted identifiers to lower case, while kysely always
    // emits quoted camelCase — every camelCase column here must stay quoted
    // or the writes in actor-syncer/cursor-manager fail at runtime.
    await sql`
      CREATE TABLE IF NOT EXISTS stratos_enrollment (
        did TEXT PRIMARY KEY,
        "serviceUrl" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )
    `.execute(rawDb)
    await sql`
      CREATE TABLE IF NOT EXISTS stratos_boundary
      (
        did      TEXT NOT NULL,
        boundary TEXT NOT NULL,
        PRIMARY KEY (did, boundary)
      )
    `.execute(rawDb)
    await sql`
      CREATE TABLE IF NOT EXISTS stratos_sync_cursor (
        did TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        "updatedAt" TEXT NOT NULL
      )
    `.execute(rawDb)
    await sql`
      CREATE TABLE IF NOT EXISTS post (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        creator TEXT NOT NULL,
        text TEXT NOT NULL,
        "createdAt" TEXT NOT NULL,
        "indexedAt" TEXT NOT NULL,
        "sortAt" TEXT GENERATED ALWAYS AS (LEAST("createdAt", "indexedAt")) STORED NOT NULL
      )
    `.execute(rawDb)
    await sql`
      CREATE TABLE IF NOT EXISTS stratos_record (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        json TEXT NOT NULL,
        "indexedAt" TEXT NOT NULL
      )
    `.execute(rawDb)
    await sql`
      CREATE TABLE IF NOT EXISTS stratos_record_boundary (
        uri TEXT NOT NULL,
        boundary TEXT NOT NULL,
        PRIMARY KEY (uri, boundary)
      )
    `.execute(rawDb)

    for (const { table, from, to } of LEGACY_LOWERCASE_COLUMNS) {
      await renameLegacyColumn(rawDb, table, from, to)
    }

    // Optimized index for boundary-based hydration
    await sql`
      CREATE INDEX IF NOT EXISTS stratos_post_boundary_idx
      ON stratos_record_boundary (boundary)
    `.execute(rawDb)
    // Optimized index for actor-based feed queries
    await sql`
      CREATE INDEX IF NOT EXISTS stratos_post_did_indexed_at_idx
      ON post (creator, "indexedAt" DESC)
    `.execute(rawDb)
  } catch (err) {
    console.error(
      { err },
      'failed to initialize stratos indexer tables/indexes',
    )
  }
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
