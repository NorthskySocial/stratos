import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as pgSchemaModule from './schema/pg-index.js'

export type StratosPgDb = PostgresJsDatabase<typeof pgSchemaModule.pgSchema>

export type StratosPgDbOrTx = PostgresJsDatabase<typeof pgSchemaModule.pgSchema>

export function createStratosPgDb(
  connectionString: string,
  schemaName?: string,
): StratosPgDb {
  const client = postgres(connectionString, {
    max: 10,
    ...(schemaName ? { search_path: schemaName } : {}),
  })
  return drizzle({ client, schema: pgSchemaModule.pgSchema })
}

export async function migrateStratosPgDb(
  db: StratosPgDb,
  schemaName?: string,
): Promise<void> {
  await ensureSchema(db, schemaName)
  await createRepoTables(db)
  await createRecordTables(db)
  await createBlobTables(db)
  await createBacklinkTables(db)
  await createSequenceTables(db)
  await createSigningKeyTables(db)
}

async function ensureSchema(db: StratosPgDb, schemaName?: string) {
  if (schemaName) {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`))
    await db.execute(sql.raw(`SET search_path TO "${schemaName}"`))
  }
}

async function createRepoTables(db: StratosPgDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_repo_root (
      did TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      rev TEXT NOT NULL,
      "indexedAt" TEXT NOT NULL
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_repo_block (
      cid TEXT PRIMARY KEY,
      "repoRev" TEXT NOT NULL,
      size INTEGER NOT NULL,
      content BYTEA NOT NULL
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stratos_repo_block_repo_rev_idx 
    ON stratos_repo_block("repoRev", cid)
  `)
}

async function createRecordTables(db: StratosPgDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_record (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      "repoRev" TEXT NOT NULL,
      "indexedAt" TEXT NOT NULL,
      "takedownRef" TEXT
    )
  `)

  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stratos_record_cid_idx ON stratos_record(cid)`,
  )
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stratos_record_collection_idx ON stratos_record(collection)`,
  )
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stratos_record_repo_rev_idx ON stratos_record("repoRev")`,
  )
}

async function createBlobTables(db: StratosPgDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_blob (
      cid TEXT PRIMARY KEY,
      "mimeType" TEXT NOT NULL,
      size INTEGER NOT NULL,
      "tempKey" TEXT,
      width INTEGER,
      height INTEGER,
      "createdAt" TEXT NOT NULL,
      "takedownRef" TEXT
    )
  `)

  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stratos_blob_tempkey_idx ON stratos_blob("tempKey")`,
  )

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_record_blob (
      "blobCid" TEXT NOT NULL,
      "recordUri" TEXT NOT NULL,
      PRIMARY KEY ("blobCid", "recordUri")
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_blob_boundary
    (
      "blobCid" TEXT NOT NULL,
      boundary  TEXT NOT NULL,
      PRIMARY KEY ("blobCid", boundary)
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stratos_blob_boundary_blob_cid_idx ON stratos_blob_boundary("blobCid")
  `)
}

async function createBacklinkTables(db: StratosPgDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_backlink (
      uri TEXT NOT NULL,
      path TEXT NOT NULL,
      "linkTo" TEXT NOT NULL,
      PRIMARY KEY (uri, path)
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS stratos_backlink_link_to_idx 
    ON stratos_backlink(path, "linkTo")
  `)
}

async function createSequenceTables(db: StratosPgDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_seq (
      seq SERIAL PRIMARY KEY,
      did TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      event BYTEA NOT NULL,
      invalidated INTEGER NOT NULL DEFAULT 0,
      "sequencedAt" TEXT NOT NULL
    )
  `)

  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stratos_seq_did_idx ON stratos_seq(did)`,
  )
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS stratos_seq_sequenced_at_idx ON stratos_seq("sequencedAt")`,
  )
}

async function createSigningKeyTables(db: StratosPgDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stratos_signing_key (
      did TEXT PRIMARY KEY,
      key BYTEA NOT NULL
    )
  `)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function closeStratosPgDb(db: StratosPgDb): Promise<void> {
  // postgres.js client reference is not directly accessible from drizzle instance,
  // so callers should manage the postgres client lifecycle separately if needed
}
