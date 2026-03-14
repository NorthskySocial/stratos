// Direct PostgreSQL access to the Stratos service database for E2E tests.
// Used when running with --postgres / STRATOS_E2E_BACKEND=postgres.
// Connects to the same PG instance that the Stratos container uses (exposed on localhost:5432).

import postgres from 'npm:postgres@3'
import { createHash } from 'node:crypto'

const PG_URL =
  Deno.env.get('STRATOS_E2E_POSTGRES_URL') ||
  'postgres://stratos:stratos@localhost:5432/stratos'

function getClient() {
  return postgres(PG_URL, { max: 1 })
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function actorSchemaName(did: string): string {
  const hash = sha256Hex(did)
  return `actor_${hash.slice(0, 12)}`
}

/** Enroll a user directly in the service-level PG database */
export async function enrollUser(
  did: string,
  pdsEndpoint?: string,
  boundaries?: string[],
): Promise<void> {
  const sql = getClient()
  try {
    const enrolledAt = new Date().toISOString()
    await sql`
      INSERT INTO enrollment (did, "enrolledAt", "pdsEndpoint")
      VALUES (${did}, ${enrolledAt}, ${pdsEndpoint ?? null})
      ON CONFLICT (did) DO UPDATE
        SET "enrolledAt" = EXCLUDED."enrolledAt",
            "pdsEndpoint" = EXCLUDED."pdsEndpoint"
    `

    if (boundaries && boundaries.length > 0) {
      await sql`DELETE FROM enrollment_boundary WHERE did = ${did}`
      for (const boundary of boundaries) {
        await sql`
          INSERT INTO enrollment_boundary (did, boundary)
          VALUES (${did}, ${boundary})
        `
      }
    }
  } finally {
    await sql.end()
  }
}

/** Create the per-actor PG schema with all required tables */
export async function createActorStore(did: string): Promise<void> {
  const schemaName = actorSchemaName(did)
  const sql = getClient()
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
    await sql.unsafe(`SET search_path TO "${schemaName}"`)

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS stratos_repo_root (
        did TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        rev TEXT NOT NULL,
        "indexedAt" TEXT NOT NULL
      )
    `)

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS stratos_repo_block (
        cid TEXT PRIMARY KEY,
        "repoRev" TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BYTEA NOT NULL
      )
    `)
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS stratos_repo_block_repo_rev_idx
      ON stratos_repo_block("repoRev", cid)
    `)

    await sql.unsafe(`
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
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS stratos_record_cid_idx ON stratos_record(cid)`,
    )
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS stratos_record_collection_idx ON stratos_record(collection)`,
    )
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS stratos_record_repo_rev_idx ON stratos_record("repoRev")`,
    )

    await sql.unsafe(`
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
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS stratos_blob_tempkey_idx ON stratos_blob("tempKey")`,
    )

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS stratos_record_blob (
        "blobCid" TEXT NOT NULL,
        "recordUri" TEXT NOT NULL,
        PRIMARY KEY ("blobCid", "recordUri")
      )
    `)

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS stratos_backlink (
        uri TEXT NOT NULL,
        path TEXT NOT NULL,
        "linkTo" TEXT NOT NULL,
        PRIMARY KEY (uri, path)
      )
    `)
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS stratos_backlink_link_to_idx
      ON stratos_backlink(path, "linkTo")
    `)

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS stratos_seq (
        seq SERIAL PRIMARY KEY,
        did TEXT NOT NULL,
        "eventType" TEXT NOT NULL,
        event BYTEA NOT NULL,
        invalidated INTEGER NOT NULL DEFAULT 0,
        "sequencedAt" TEXT NOT NULL
      )
    `)
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS stratos_seq_did_idx ON stratos_seq(did)`,
    )
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS stratos_seq_sequenced_at_idx ON stratos_seq("sequencedAt")`,
    )
  } finally {
    await sql.end()
  }
}

/** Replace all boundaries for a user */
export async function setBoundaries(
  did: string,
  boundaries: string[],
): Promise<void> {
  const sql = getClient()
  try {
    await sql`DELETE FROM enrollment_boundary WHERE did = ${did}`
    for (const boundary of boundaries) {
      await sql`
        INSERT INTO enrollment_boundary (did, boundary)
        VALUES (${did}, ${boundary})
      `
    }
  } finally {
    await sql.end()
  }
}

/** Get all boundaries for a user */
export async function getBoundaries(did: string): Promise<string[]> {
  const sql = getClient()
  try {
    const rows = await sql`
      SELECT boundary FROM enrollment_boundary WHERE did = ${did}
    `
    return rows.map((r: { boundary: string }) => r.boundary)
  } finally {
    await sql.end()
  }
}

/** Check if a user is enrolled */
export async function isEnrolled(did: string): Promise<boolean> {
  const sql = getClient()
  try {
    const rows = await sql`
      SELECT did FROM enrollment WHERE did = ${did}
    `
    return rows.length > 0
  } finally {
    await sql.end()
  }
}
