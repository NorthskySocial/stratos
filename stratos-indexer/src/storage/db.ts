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
 * Maps every historical column layout forward to the shared AppView schema:
 * unquoted DDL that Postgres folded to lower case, and the quoted
 * createdAt/updatedAt intermediate that predates enrolledAt/lastChecked.
 * Each rename no-ops when the source column is absent or the target column
 * exists, so shared-target entries cannot error. If two source columns for
 * one target coexist, the earlier entry wins and the later column stays.
 */
const LEGACY_COLUMN_RENAMES = [
  { table: 'stratos_enrollment', from: 'serviceurl', to: 'serviceUrl' },
  { table: 'stratos_enrollment', from: 'createdat', to: 'enrolledAt' },
  { table: 'stratos_enrollment', from: 'createdAt', to: 'enrolledAt' },
  { table: 'stratos_enrollment', from: 'enrolledat', to: 'enrolledAt' },
  { table: 'stratos_enrollment', from: 'updatedat', to: 'lastChecked' },
  { table: 'stratos_enrollment', from: 'updatedAt', to: 'lastChecked' },
  { table: 'stratos_enrollment', from: 'lastchecked', to: 'lastChecked' },
  { table: 'stratos_sync_cursor', from: 'updatedat', to: 'updatedAt' },
  { table: 'stratos_record', from: 'indexedat', to: 'indexedAt' },
] as const

export function createDatabase(cfg: DbConfig): Database {
  return new Database({
    url: cfg.postgresUrl,
    schema: cfg.schema,
    poolSize: cfg.poolSize,
  })
}

/** `Database` keeps its kysely instance off its public type. */
interface RawDbHolder {
  db: Kysely<Record<string, unknown>>
}

/**
 * Rename a legacy column to its current name. No-ops when the table is
 * absent, already renamed, or freshly created, so it is safe to rerun.
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
 * Safe to rerun; must complete before any indexing write runs.
 */
export async function ensureIndexerSchema(db: Database): Promise<void> {
  try {
    const { db: rawDb } = db as unknown as RawDbHolder
    // Postgres folds unquoted identifiers to lower case, while kysely always
    // emits quoted camelCase — every camelCase column here must stay quoted
    // or the writes in actor-syncer/cursor-manager fail at runtime.
    //
    // stratos_enrollment is shared with the AppView, whose migration declares
    // these exact columns — see atproto-stratos bsky db/tables/stratos-enrollment.ts.
    await sql`
      CREATE TABLE IF NOT EXISTS stratos_enrollment (
        did TEXT PRIMARY KEY,
        "serviceUrl" TEXT NOT NULL,
        "enrolledAt" TEXT NOT NULL,
        "lastChecked" TEXT NOT NULL,
        boundaries TEXT
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

    for (const { table, from, to } of LEGACY_COLUMN_RENAMES) {
      await renameLegacyColumn(rawDb, table, from, to)
    }

    // Legacy bootstraps predate the boundaries column, and CREATE TABLE
    // IF NOT EXISTS cannot add it to an existing table.
    await sql`
      ALTER TABLE stratos_enrollment
      ADD COLUMN IF NOT EXISTS boundaries TEXT
    `.execute(rawDb)

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
    throw err
  }
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
