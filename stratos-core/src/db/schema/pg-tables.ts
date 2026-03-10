import {
  pgTable,
  text,
  integer,
  bytea,
  primaryKey,
  index,
  serial,
} from 'drizzle-orm/pg-core'

export const pgStratosRepoRoot = pgTable('stratos_repo_root', {
  did: text('did').primaryKey(),
  cid: text('cid').notNull(),
  rev: text('rev').notNull(),
  indexedAt: text('indexedAt').notNull(),
})

export const pgStratosRepoBlock = pgTable(
  'stratos_repo_block',
  {
    cid: text('cid').primaryKey(),
    repoRev: text('repoRev').notNull(),
    size: integer('size').notNull(),
    content: bytea('content').notNull(),
  },
  (table) => [
    index('stratos_repo_block_repo_rev_idx').on(table.repoRev, table.cid),
  ],
)

export const pgStratosRecord = pgTable(
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

export const pgStratosBlob = pgTable(
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

export const pgStratosRecordBlob = pgTable(
  'stratos_record_blob',
  {
    blobCid: text('blobCid').notNull(),
    recordUri: text('recordUri').notNull(),
  },
  (table) => [primaryKey({ columns: [table.blobCid, table.recordUri] })],
)

export const pgStratosBacklink = pgTable(
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

export const pgStratosSigningKey = pgTable('stratos_signing_key', {
  did: text('did').primaryKey(),
  key: bytea('key').notNull(),
})

export const pgStratosSeq = pgTable(
  'stratos_seq',
  {
    seq: serial('seq').primaryKey(),
    did: text('did').notNull(),
    eventType: text('eventType').notNull(),
    event: bytea('event').notNull(),
    invalidated: integer('invalidated').notNull().default(0),
    sequencedAt: text('sequencedAt').notNull(),
  },
  (table) => [
    index('stratos_seq_did_idx').on(table.did),
    index('stratos_seq_sequenced_at_idx').on(table.sequencedAt),
  ],
)

export type PgStratosRepoRoot = typeof pgStratosRepoRoot.$inferSelect
export type PgStratosRepoRootInsert = typeof pgStratosRepoRoot.$inferInsert

export type PgStratosRepoBlock = typeof pgStratosRepoBlock.$inferSelect
export type PgStratosRepoBlockInsert = typeof pgStratosRepoBlock.$inferInsert

export type PgStratosRecord = typeof pgStratosRecord.$inferSelect
export type PgStratosRecordInsert = typeof pgStratosRecord.$inferInsert

export type PgStratosBlob = typeof pgStratosBlob.$inferSelect
export type PgStratosBlobInsert = typeof pgStratosBlob.$inferInsert

export type PgStratosRecordBlob = typeof pgStratosRecordBlob.$inferSelect
export type PgStratosRecordBlobInsert = typeof pgStratosRecordBlob.$inferInsert

export type PgStratosBacklink = typeof pgStratosBacklink.$inferSelect
export type PgStratosBacklinkInsert = typeof pgStratosBacklink.$inferInsert

export type PgStratosSeq = typeof pgStratosSeq.$inferSelect
export type PgStratosSeqInsert = typeof pgStratosSeq.$inferInsert
