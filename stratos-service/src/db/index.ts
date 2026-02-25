import { createClient } from '@libsql/client'
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import { sql } from 'drizzle-orm'
import * as schema from './schema.js'

export {
  oauthSession,
  oauthState,
  enrollment,
  enrollmentBoundary,
} from './schema.js'
export type {
  OAuthSession,
  NewOAuthSession,
  OAuthState,
  NewOAuthState,
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
    CREATE TABLE IF NOT EXISTS enrollment (
      did TEXT PRIMARY KEY,
      enrolledAt TEXT NOT NULL,
      pdsEndpoint TEXT
    )
  `)

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
 */
export async function closeServiceDb(db: ServiceDb): Promise<void> {
  db._client.close()
}
