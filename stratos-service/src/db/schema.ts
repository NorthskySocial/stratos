import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core'

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
 * Enrollment storage - tracks enrolled users
 */
export const enrollment = sqliteTable('enrollment', {
  did: text('did').primaryKey(),
  enrolledAt: text('enrolledAt').notNull(),
  pdsEndpoint: text('pdsEndpoint'),
  signingKeyDid: text('signingKeyDid').notNull(),
  active: text('active').notNull().default('true'),
  enrollmentRkey: text('enrollmentRkey'),
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

export type OAuthSession = typeof oauthSession.$inferSelect
export type NewOAuthSession = typeof oauthSession.$inferInsert
export type OAuthState = typeof oauthState.$inferSelect
export type NewOAuthState = typeof oauthState.$inferInsert
export type Enrollment = typeof enrollment.$inferSelect
export type NewEnrollment = typeof enrollment.$inferInsert
export type EnrollmentBoundary = typeof enrollmentBoundary.$inferSelect
export type NewEnrollmentBoundary = typeof enrollmentBoundary.$inferInsert
