import { createClient } from '@libsql/client'
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import { sql, type SQL } from 'drizzle-orm'
import * as schema from './schema.js'

export {
  oauthSession,
  oauthState,
  adminSession,
  adminUser,
  enrollment,
  enrollmentBoundary,
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
/**
 * Add a column that an older database may already have.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so a re-run has to be tolerated.
 * Swallowing every error would let the service start with the column missing,
 * so only the duplicate-column case is ignored.
 */
async function addEnrollmentColumn(
  db: ServiceDb,
  statement: SQL,
): Promise<void> {
  try {
    await db.run(statement)
  } catch (err) {
    // The driver wraps the SQLite error, so the text we need sits on a
    // `cause` further down the chain, not on the message we are handed.
    if (!isDuplicateColumn(err)) throw err
  }
}

/** True when `err`, or anything it wraps, is SQLite's duplicate-column error. */
function isDuplicateColumn(err: unknown): boolean {
  let current: unknown = err
  while (current instanceof Error) {
    if (current.message.includes('duplicate column name')) return true
    current = current.cause
  }
  return false
}

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
      isService INTEGER NOT NULL DEFAULT 0,
      custody TEXT NOT NULL DEFAULT 'stratos',
      repoHost TEXT
    )
  `)

  // Migration: add enrollmentRkey column if missing (for existing databases)
  await addEnrollmentColumn(
    db,
    sql`ALTER TABLE enrollment ADD COLUMN enrollmentRkey TEXT`,
  )

  // Migration: add isService column if missing (for existing databases)
  await addEnrollmentColumn(
    db,
    sql`ALTER TABLE enrollment ADD COLUMN isService INTEGER NOT NULL DEFAULT 0`,
  )

  // Migration: add custody column if missing (for existing databases)
  await addEnrollmentColumn(
    db,
    sql`ALTER TABLE enrollment ADD COLUMN custody TEXT NOT NULL DEFAULT 'stratos'`,
  )

  // Migration: add repoHost column if missing (for existing databases)
  await addEnrollmentColumn(
    db,
    sql`ALTER TABLE enrollment ADD COLUMN repoHost TEXT`,
  )

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
}

/**
 * Close the service database connection
 *
 * @param db - Service database connection
 */
export async function closeServiceDb(db: ServiceDb): Promise<void> {
  db._client.close()
}
