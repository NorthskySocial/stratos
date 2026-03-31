import { Client, createClient } from '@libsql/client'
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import { sql } from 'drizzle-orm'
import * as schemaModule from './schema/index.js'

export * from './schema/index.js'
export * from './schema/pg-index.js'
export * from './util.js'
export * from './pg.js'

export type StratosDb = LibSQLDatabase<typeof schemaModule.schema> & {
  _client: Client
  _initialized: Promise<void>
}

/**
 * Generic type for a Stratos database or transaction
 */
export type StratosDbOrTx =
  | LibSQLDatabase<typeof schemaModule.schema>
  | (Omit<LibSQLDatabase<typeof schemaModule.schema>, 'batch'> & {
      batch?: never
    })

/**
 * Default SQLite pragmas for stratos databases
 */
const DEFAULT_PRAGMAS: Record<string, string> = {}

/**
 * Creates a connection to a stratos SQLite database.
 * Note: The returned database has async initialization. Call `await db._initialized`
 * before using if you need WAL mode guaranteed, or it will be applied lazily.
 *
 * @param location - Path to the SQLite database file. Use ':memory:' for in-memory databases.
 * @param opts - Optional configuration options
 * @returns A drizzle database instance
 * @throws {Error} If the database cannot be opened or initialized
 */
export function createStratosDb(
  location: string,
  opts?: { pragmas?: Record<string, string> },
): StratosDb {
  const client = createClient({
    url: location === ':memory:' ? ':memory:' : `file:${location}`,
  })

  const pragmas = {
    ...DEFAULT_PRAGMAS,
    ...(opts?.pragmas ?? {}),
  }

  const baseDb = drizzle({ client, schema: schemaModule.schema })
  const db = baseDb as unknown as StratosDb
  db._client = client

  // Build pragma statements
  const pragmaStatements = Object.entries(pragmas).map(([pragma, value]) =>
    sql.raw(`PRAGMA ${pragma} = ${value}`),
  )

  // Enable WAL mode for better concurrency
  pragmaStatements.push(sql.raw('PRAGMA journal_mode = WAL'))

  // Initialize pragmas - store the promise so callers can await if needed
  db._initialized = (async () => {
    for (const stmt of pragmaStatements) {
      try {
        await db.run(stmt)
      } catch (err) {
        // Ignore SQLITE_BUSY errors for WAL pragma - another connection may have set it
        const errCode = (err as { code?: string })?.code
        if (errCode !== 'SQLITE_BUSY') {
          throw err
        }
      }
    }
  })()

  return db
}

/**
 * Run database migrations to create all required tables
 */
export async function migrateStratosDb(db: StratosDb): Promise<void> {
  // Create tables using raw SQL since we're managing migrations manually
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_repo_root (
      did TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      rev TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    )
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_repo_block (
      cid TEXT PRIMARY KEY,
      repoRev TEXT NOT NULL,
      size INTEGER NOT NULL,
      content BLOB NOT NULL
    )
  `)

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS stratos_repo_block_repo_rev_idx 
    ON stratos_repo_block(repoRev, cid)
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_record (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      repoRev TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
      takedownRef TEXT
    )
  `)

  await db.run(
    sql`CREATE INDEX IF NOT EXISTS stratos_record_cid_idx ON stratos_record(cid)`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS stratos_record_collection_idx ON stratos_record(collection)`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS stratos_record_repo_rev_idx ON stratos_record(repoRev)`,
  )

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_blob (
      cid TEXT PRIMARY KEY,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      tempKey TEXT,
      width INTEGER,
      height INTEGER,
      createdAt TEXT NOT NULL,
      takedownRef TEXT
    )
  `)

  await db.run(
    sql`CREATE INDEX IF NOT EXISTS stratos_blob_tempkey_idx ON stratos_blob(tempKey)`,
  )

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_record_blob (
      blobCid TEXT NOT NULL,
      recordUri TEXT NOT NULL,
      PRIMARY KEY (blobCid, recordUri)
    )
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_backlink (
      uri TEXT NOT NULL,
      path TEXT NOT NULL,
      linkTo TEXT NOT NULL,
      PRIMARY KEY (uri, path)
    )
  `)

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS stratos_backlink_link_to_idx 
    ON stratos_backlink(path, linkTo)
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS stratos_seq (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      did TEXT NOT NULL,
      eventType TEXT NOT NULL,
      event BLOB NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      sequencedAt TEXT NOT NULL
    )
  `)

  await db.run(
    sql`CREATE INDEX IF NOT EXISTS stratos_seq_did_idx ON stratos_seq(did)`,
  )
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS stratos_seq_sequenced_at_idx ON stratos_seq(sequencedAt)`,
  )
}

/**
 * Closes the stratos database connection
 */
export async function closeStratosDb(db: StratosDb): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  await (db._client as any).close()
}
