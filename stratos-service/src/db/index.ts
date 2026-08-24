import { createClient } from '@libsql/client'
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import { sql } from 'drizzle-orm'
import * as schema from './schema.js'

export {
  oauthSession,
  oauthState,
  adminSession,
  adminUser,
  enrollment,
  enrollmentBoundary,
  enrollmentPdsSync,
} from './schema.js'
export type {
  OAuthSession,
  NewOAuthSession,
  OAuthState,
  NewOAuthState,
  AdminSession,
  NewAdminSession,
  Enrollment,
  NewEnrollment,
  EnrollmentBoundary,
  NewEnrollmentBoundary,
  EnrollmentPdsSync,
  NewEnrollmentPdsSync,
} from './schema.js'

export type ServiceDb = LibSQLDatabase<typeof schema> & {
  _client: ReturnType<typeof createClient>
}

/**
 * Create a service database connection
 *
 * @param location - Path to the database file
 * @returns Service database connection
 */
export function createServiceDb(location: string): ServiceDb {
  const client = createClient({
    url: `file:${location}`,
  })
  const base = drizzle({ client, schema }) as unknown as ServiceDb
  base._client = client
  return base
}

/**
 * Run migrations on the service database
 *
 * @param db - Service database connection
 */
export async function migrateServiceDb(db: ServiceDb): Promise<void> {
  // Create tables if not exist
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS oauth_session (
      key TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS oauth_state (
      key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS admin_session (
      key TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    )
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS admin_user (
      did TEXT PRIMARY KEY,
      addedAt TEXT NOT NULL,
      addedBy TEXT
    )
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS enrollment (
      did TEXT PRIMARY KEY,
      enrolledAt TEXT NOT NULL,
      pdsEndpoint TEXT,
      signingKeyDid TEXT NOT NULL,
      active TEXT NOT NULL DEFAULT 'true',
      enrollmentRkey TEXT,
      isService INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Migration: add enrollmentRkey column if missing (for existing databases)
  await db
    .run(
      sql`
    ALTER TABLE enrollment ADD COLUMN enrollmentRkey TEXT
  `,
    )
    .catch(() => {})

  // Migration: add isService column if missing (for existing databases)
  await db
    .run(
      sql`
    ALTER TABLE enrollment ADD COLUMN isService INTEGER NOT NULL DEFAULT 0
  `,
    )
    .catch(() => {})

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS enrollment_boundary (
      did TEXT NOT NULL,
      boundary TEXT NOT NULL,
      PRIMARY KEY (did, boundary)
    )
  `)

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS enrollment_boundary_did_idx ON enrollment_boundary(did)
  `)

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS enrollment_pds_sync (
      did TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attemptCount INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt TEXT NOT NULL,
      firstQueuedAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastError TEXT
    )
  `)

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS enrollment_pds_sync_due_idx ON enrollment_pds_sync(status, nextAttemptAt)
  `)
}

/**
 * Close the service database connection
 *
 * @param db - Service database connection
 */
export async function closeServiceDb(db: ServiceDb): Promise<void> {
  db._client.close()
}
