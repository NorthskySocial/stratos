import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

/**
 * Stratos repo root table - tracks the current state of a repo
 */
export const stratosRepoRoot = sqliteTable('stratos_repo_root', {
  did: text('did').primaryKey(),
  cid: text('cid').notNull(),
  rev: text('rev').notNull(),
  indexedAt: text('indexedAt').notNull(),
})

/**
 * Stratos repo block table - stores individual blocks
 */
export const stratosRepoBlock = sqliteTable(
  'stratos_repo_block',
  {
    cid: text('cid').primaryKey(),
    repoRev: text('repoRev').notNull(),
    size: integer('size').notNull(),
    content: blob('content', { mode: 'buffer' }).notNull(),
  },
  (table) => [
    index('stratos_repo_block_repo_rev_idx').on(table.repoRev, table.cid),
  ],
)

/**
 * Stratos record table - indexes records
 */
export const stratosRecord = sqliteTable(
  'stratos_record',
  {
    uri: text('uri').primaryKey(),
    cid: text('cid').notNull(),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    repoRev: text('repoRev').notNull(),
    indexedAt: text('indexedAt').notNull(),
    takedownRef: text('takedownRef'),
  },
  (table) => [
    index('stratos_record_cid_idx').on(table.cid),
    index('stratos_record_collection_idx').on(table.collection),
    index('stratos_record_repo_rev_idx').on(table.repoRev),
  ],
)

/**
 * Stratos blob table - tracks blob metadata
 */
export const stratosBlob = sqliteTable(
  'stratos_blob',
  {
    cid: text('cid').primaryKey(),
    mimeType: text('mimeType').notNull(),
    size: integer('size').notNull(),
    tempKey: text('tempKey'),
    width: integer('width'),
    height: integer('height'),
    createdAt: text('createdAt').notNull(),
    takedownRef: text('takedownRef'),
  },
  (table) => [index('stratos_blob_tempkey_idx').on(table.tempKey)],
)

/**
 * Stratos record-blob association table
 */
export const stratosRecordBlob = sqliteTable(
  'stratos_record_blob',
  {
    blobCid: text('blobCid').notNull(),
    recordUri: text('recordUri').notNull(),
  },
  (table) => [primaryKey({ columns: [table.blobCid, table.recordUri] })],
)

/**
 * Stratos backlink table - tracks references between records
 */
export const stratosBacklink = sqliteTable(
  'stratos_backlink',
  {
    uri: text('uri').notNull(),
    path: text('path').notNull(),
    linkTo: text('linkTo').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.uri, table.path] }),
    index('stratos_backlink_link_to_idx').on(table.path, table.linkTo),
  ],
)

/**
 * Stratos sequencer table - tracks events for sync
 */
export const stratosSeq = sqliteTable(
  'stratos_seq',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    did: text('did').notNull(),
    eventType: text('eventType').notNull(),
    event: blob('event', { mode: 'buffer' }).notNull(),
    invalidated: integer('invalidated').notNull().default(0),
    sequencedAt: text('sequencedAt').notNull(),
  },
  (table) => [
    index('stratos_seq_did_idx').on(table.did),
    index('stratos_seq_sequenced_at_idx').on(table.sequencedAt),
  ],
)

export type StratosRepoRoot = typeof stratosRepoRoot.$inferSelect
export type StratosRepoRootInsert = typeof stratosRepoRoot.$inferInsert

export type StratosRepoBlock = typeof stratosRepoBlock.$inferSelect
export type StratosRepoBlockInsert = typeof stratosRepoBlock.$inferInsert

export type StratosRecord = typeof stratosRecord.$inferSelect
export type StratosRecordInsert = typeof stratosRecord.$inferInsert

export type StratosBlob = typeof stratosBlob.$inferSelect
export type StratosBlobInsert = typeof stratosBlob.$inferInsert

export type StratosRecordBlob = typeof stratosRecordBlob.$inferSelect
export type StratosRecordBlobInsert = typeof stratosRecordBlob.$inferInsert

export type StratosBacklink = typeof stratosBacklink.$inferSelect
export type StratosBacklinkInsert = typeof stratosBacklink.$inferInsert

export type StratosSeq = typeof stratosSeq.$inferSelect
export type StratosSeqInsert = typeof stratosSeq.$inferInsert

/**
 * Stratos sequencer event types
 */
export type StratosSeqEventType = 'append' | 'sync'
