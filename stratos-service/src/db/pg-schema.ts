import { pgTable, text, boolean, index, primaryKey } from 'drizzle-orm/pg-core'

export const pgOauthSession = pgTable('oauth_session', {
  key: text('key').primaryKey(),
  session: text('session').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

export const pgOauthState = pgTable('oauth_state', {
  key: text('key').primaryKey(),
  state: text('state').notNull(),
  createdAt: text('createdAt').notNull(),
})

export const pgAdminSession = pgTable('admin_session', {
  key: text('key').primaryKey(),
  did: text('did').notNull(),
  createdAt: text('createdAt').notNull(),
  expiresAt: text('expiresAt').notNull(),
})

export const pgAdminUser = pgTable('admin_user', {
  did: text('did').primaryKey(),
  addedAt: text('addedAt').notNull(),
  addedBy: text('addedBy'),
})

export const pgEnrollment = pgTable('enrollment', {
  did: text('did').primaryKey(),
  enrolledAt: text('enrolledAt').notNull(),
  pdsEndpoint: text('pdsEndpoint'),
  signingKeyDid: text('signingKeyDid').notNull(),
  active: text('active').notNull().default('true'),
  enrollmentRkey: text('enrollmentRkey'),
  isService: boolean('isService').notNull().default(false),
  custody: text('custody').notNull().default('stratos'),
  repoHost: text('repoHost'),
  capabilityVerdict: text('capabilityVerdict'),
})

export const pgEnrollmentBoundary = pgTable(
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

export type PgOAuthSession = typeof pgOauthSession.$inferSelect
export type PgNewOAuthSession = typeof pgOauthSession.$inferInsert
export type PgOAuthState = typeof pgOauthState.$inferSelect
export type PgNewOAuthState = typeof pgOauthState.$inferInsert
export type PgAdminSession = typeof pgAdminSession.$inferSelect
export type PgNewAdminSession = typeof pgAdminSession.$inferInsert
export type PgEnrollment = typeof pgEnrollment.$inferSelect
export type PgNewEnrollment = typeof pgEnrollment.$inferInsert
export type PgEnrollmentBoundary = typeof pgEnrollmentBoundary.$inferSelect
export type PgNewEnrollmentBoundary = typeof pgEnrollmentBoundary.$inferInsert
