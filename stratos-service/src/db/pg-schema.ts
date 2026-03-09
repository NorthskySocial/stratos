import { pgTable, text, index, primaryKey } from 'drizzle-orm/pg-core'

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

export const pgEnrollment = pgTable('enrollment', {
  did: text('did').primaryKey(),
  enrolledAt: text('enrolledAt').notNull(),
  pdsEndpoint: text('pdsEndpoint'),
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
export type PgEnrollment = typeof pgEnrollment.$inferSelect
export type PgNewEnrollment = typeof pgEnrollment.$inferInsert
export type PgEnrollmentBoundary = typeof pgEnrollmentBoundary.$inferSelect
export type PgNewEnrollmentBoundary = typeof pgEnrollmentBoundary.$inferInsert
