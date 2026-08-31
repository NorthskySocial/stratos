import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

export const post = sqliteTable(
  'post',
  {
    uri: text('uri').primaryKey(),
    did: text('did').notNull(),
    cid: text('cid').notNull(),
    sortAt: text('sortAt').notNull(),
    indexedAt: text('indexedAt').notNull(),
    recordJson: text('recordJson').notNull(),
    blobRefsJson: text('blobRefsJson').notNull(),
  },
  (table) => [index('post_sort_at_uri_idx').on(table.sortAt, table.uri)],
)

export const postBoundary = sqliteTable(
  'post_boundary',
  {
    uri: text('uri').notNull(),
    boundary: text('boundary').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.uri, table.boundary] }),
    index('post_boundary_boundary_uri_idx').on(table.boundary, table.uri),
  ],
)

export const syncCursor = sqliteTable('sync_cursor', {
  did: text('did').primaryKey(),
  seq: integer('seq').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

export const enrolledActor = sqliteTable('enrolled_actor', {
  did: text('did').primaryKey(),
  boundariesJson: text('boundariesJson').notNull(),
  enrolledAt: text('enrolledAt').notNull(),
  lastSeenAt: text('lastSeenAt').notNull(),
})

export const spaceSyncCursor = sqliteTable(
  'space_sync_cursor',
  {
    spaceUri: text('spaceUri').notNull(),
    did: text('did').notNull(),
    cursor: text('cursor').notNull(),
    updatedAt: text('updatedAt').notNull(),
  },
  (table) => [primaryKey({ columns: [table.spaceUri, table.did] })],
)

export const spaceMemberSnapshot = sqliteTable(
  'space_member_snapshot',
  {
    boundary: text('boundary').notNull(),
    did: text('did').notNull(),
    custody: text('custody', { enum: ['pds', 'stratos'] }).notNull(),
    host: text('host'),
  },
  (table) => [primaryKey({ columns: [table.boundary, table.did] })],
)
