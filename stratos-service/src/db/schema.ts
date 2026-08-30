import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core'

/**
 * OAuth session storage - stores authenticated user sessions
 */
export const oauthSession = sqliteTable('oauth_session', {
  key: text('key').primaryKey(),
  session: text('session').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

/**
 * OAuth state storage - stores authorization flow state
 */
export const oauthState = sqliteTable('oauth_state', {
  key: text('key').primaryKey(),
  state: text('state').notNull(),
  createdAt: text('createdAt').notNull(),
})

/**
 * Admin session storage - server-side sessions for OAuth-authorized admins.
 * The cookie holds only the opaque `key`; the OAuth token never leaves the DB.
 */
export const adminSession = sqliteTable('admin_session', {
  key: text('key').primaryKey(),
  did: text('did').notNull(),
  createdAt: text('createdAt').notNull(),
  expiresAt: text('expiresAt').notNull(),
})

/**
 * Admins granted at runtime. Config-provided admins are not stored here; the
 * effective admin set is the union of this table and STRATOS_ADMIN_DIDS.
 */
export const adminUser = sqliteTable('admin_user', {
  did: text('did').primaryKey(),
  addedAt: text('addedAt').notNull(),
  addedBy: text('addedBy'),
})

/**
 * Enrollment storage - tracks enrolled users
 */
export const enrollment = sqliteTable('enrollment', {
  did: text('did').primaryKey(),
  enrolledAt: text('enrolledAt').notNull(),
  pdsEndpoint: text('pdsEndpoint'),
  signingKeyDid: text('signingKeyDid').notNull(),
  active: text('active').notNull().default('true'),
  enrollmentRkey: text('enrollmentRkey'),
  isService: integer('isService', { mode: 'boolean' }).notNull().default(false),
  custody: text('custody').notNull().default('stratos'),
  repoHost: text('repoHost'),
})

/**
 * Enrollment boundaries - maps enrolled users to their access boundaries
 */
export const enrollmentBoundary = sqliteTable(
  'enrollment_boundary',
  {
    did: text('did').notNull(),
    boundary: text('boundary').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.did, table.boundary] }),
    index('enrollment_boundary_did_idx').on(table.did),
  ],
)

/**
 * Durable PDS enrollment-record sync queue. One row per actor: the job carries
 * no boundary payload, so superseding admin mutations collapse into one row
 * whose eventual execution writes the current truth.
 */
export const enrollmentPdsSync = sqliteTable(
  'enrollment_pds_sync',
  {
    did: text('did').primaryKey(),
    status: text('status').notNull(),
    attemptCount: integer('attemptCount').notNull().default(0),
    nextAttemptAt: text('nextAttemptAt').notNull(),
    firstQueuedAt: text('firstQueuedAt').notNull(),
    updatedAt: text('updatedAt').notNull(),
    lastError: text('lastError'),
    // Bumped on every fresh intent. An attempt carries the generation it read
    // and only clears the row while that generation is still current, so a
    // mutation that supersedes an in-flight attempt keeps its job.
    generation: integer('generation').notNull().default(0),
  },
  (table) => [
    index('enrollment_pds_sync_due_idx').on(table.status, table.nextAttemptAt),
  ],
)

export type OAuthSession = typeof oauthSession.$inferSelect
export type NewOAuthSession = typeof oauthSession.$inferInsert
export type OAuthState = typeof oauthState.$inferSelect
export type NewOAuthState = typeof oauthState.$inferInsert
export type AdminSession = typeof adminSession.$inferSelect
export type NewAdminSession = typeof adminSession.$inferInsert
export type Enrollment = typeof enrollment.$inferSelect
export type NewEnrollment = typeof enrollment.$inferInsert
export type EnrollmentBoundary = typeof enrollmentBoundary.$inferSelect
export type NewEnrollmentBoundary = typeof enrollmentBoundary.$inferInsert
export type EnrollmentPdsSync = typeof enrollmentPdsSync.$inferSelect
export type NewEnrollmentPdsSync = typeof enrollmentPdsSync.$inferInsert
