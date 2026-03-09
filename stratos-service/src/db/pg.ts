import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as pgSchema from './pg-schema.js'

export type ServicePgDb = PostgresJsDatabase<typeof pgSchema>

export function createServicePgDb(connectionString: string): ServicePgDb {
  const client = postgres(connectionString, { max: 10 })
  return drizzle({ client, schema: pgSchema })
}

export async function migrateServicePgDb(db: ServicePgDb): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oauth_session (
      key TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oauth_state (
      key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS enrollment (
      did TEXT PRIMARY KEY,
      "enrolledAt" TEXT NOT NULL,
      "pdsEndpoint" TEXT
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS enrollment_boundary (
      did TEXT NOT NULL,
      boundary TEXT NOT NULL,
      PRIMARY KEY (did, boundary)
    )
  `)

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS enrollment_boundary_did_idx ON enrollment_boundary(did)
  `)
}

export async function closeServicePgDb(db: ServicePgDb): Promise<void> {
  // postgres.js client lifecycle is managed externally
}
