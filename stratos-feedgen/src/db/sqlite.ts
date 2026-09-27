import { Client, createClient } from '@libsql/client'
import { chmodSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import {
  enrolledActor as enrolledActorTbl,
  feedgenMembershipMetadata as membershipMetadataTbl,
  post as postTbl,
  postBoundary as postBoundaryTbl,
  spaceMemberSnapshot as spaceMemberSnapshotTbl,
  spaceSyncPendingVerification as spaceSyncPendingVerificationTbl,
  spaceSyncStage as spaceSyncStageTbl,
  spaceSyncCursor as spaceSyncCursorTbl,
  syncCursor as syncCursorTbl,
} from './schema/sqlite.js'
import { sqliteSchema } from './schema/index.js'
import {
  decodeCursor,
  encodeCursor,
  BlobRef,
  EnrolledActor,
  EnrolledActorUpsert,
  FeedgenStore,
  GuardedBoundaryDeleteResult,
  IndexedPost,
  ListPostsOpts,
  ListPostsResult,
  PostUpsert,
  ProjectionCompactionBatch,
  ProjectionRetentionOptions,
  SPACE_MEMBER_INSERT_CHUNK_SIZE,
  SpaceMemberSnapshot,
  SpaceSyncStagePage,
} from './types.js'
import type { CatalogBoundary } from '../feeds/catalog-model.js'
import { blobCacheKey } from '../blob/cache.js'
import { assertPrivateSqlitePath } from '../config.js'

export type SqliteDb = LibSQLDatabase<typeof sqliteSchema> & {
  _client: Client
  _memoryAnchor?: Client
  _initialized: Promise<void>
  _location: string
}

const LEGACY_MEMBERSHIP_IMPORT_KEY = 'legacy-record-store-imported'
const CATALOG_BASELINE_KEY = 'boundary-catalog-baseline'
const DEFAULT_COMPACTION_BATCH_SIZE = 100
const PROJECTION_BYTES_METADATA_KEY = 'projection-bytes'

/**
 * SQLite permits a single writer, while a space membership pass deliberately
 * syncs several actors concurrently. Keep network work concurrent and queue
 * only the short local mutations that follow it.
 */
class SqliteWriteQueue {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined
    const completed = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = completed
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }
}

export function createSqliteDb(location: string): SqliteDb {
  const durableArtifacts = sqliteArtifactPaths(location)
  if (location !== ':memory:') {
    for (const artifact of durableArtifacts) assertPrivateSqlitePath(artifact)
  }
  const url = sqliteClientUrl(location)
  const client = createClient({
    url,
  })
  const baseDb = drizzle({ client, schema: sqliteSchema })
  const db = baseDb as unknown as SqliteDb
  db._client = client
  db._location = location
  if (location === ':memory:') {
    // Drizzle releases libSQL connections after transactions. Keep this
    // connection open so the shared in-memory database survives that release.
    db._memoryAnchor = createClient({ url })
  }
  db._initialized = (async () => {
    try {
      await db.run(sql.raw('PRAGMA journal_mode = WAL'))
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'SQLITE_BUSY') throw err
    }
    await db.run(sql.raw('PRAGMA foreign_keys = ON'))
    secureSqliteArtifacts(db)
  })()
  return db
}

/** Apply private file modes to the database and its SQLite sidecars. */
export function secureSqliteArtifacts(db: SqliteDb): void {
  for (const artifact of sqliteArtifactPaths(db._location)) {
    if (existsSync(artifact)) chmodSync(artifact, 0o600)
  }
}

function sqliteArtifactPaths(location: string): string[] {
  if (location === ':memory:') return []
  return [location, `${location}-wal`, `${location}-shm`]
}

function sqliteClientUrl(location: string): string {
  if (location !== ':memory:') return pathToFileURL(resolve(location)).href
  const uri = `file:feedgen-${randomUUID()}?mode=memory&cache=shared`
  return `file:${encodeURIComponent(uri)}`
}

function serializedPostBytes(input: PostUpsert): number {
  return Buffer.byteLength(
    [
      input.uri,
      input.did,
      input.cid,
      input.sortAt,
      input.indexedAt,
      JSON.stringify(input.record),
      JSON.stringify(input.blobRefs),
    ].join('\n'),
  )
}

function emptyCompactionResult(): ProjectionCompactionBatch {
  return {
    posts: 0,
    blobCacheEntries: 0,
    syncCursors: 0,
    spaceCursors: 0,
    stagedRecords: 0,
    pendingVerifications: 0,
    hasMore: false,
    blobCacheKeys: [],
  }
}

interface CompactedPostRow {
  uri: string
  did: string
  blobRefsJson: string
  projectionBytes: number
}

interface BlobReference {
  did: string
  cid: string
}

type SqliteMutationDb = Pick<SqliteDb, 'all' | 'delete' | 'get' | 'run'>

async function deletePostRows(
  db: SqliteMutationDb,
  rows: readonly CompactedPostRow[],
): Promise<number> {
  const uris = rows.map((row) => row.uri)
  if (uris.length === 0) return 0
  const deleted = await db.delete(postTbl).where(inArray(postTbl.uri, uris))
  return deleted.rowsAffected
}

async function evictOverBudgetPosts(
  db: SqliteMutationDb,
  currentBytes: number,
  maxBytes: number,
  limit: number,
): Promise<CompactedPostRow[]> {
  if (currentBytes <= maxBytes || limit <= 0) return []
  const candidates = await db.all<CompactedPostRow>(sql`
    SELECT uri, did, blobRefsJson, projectionBytes FROM post
    ORDER BY retainedAt ASC, sortAt ASC, uri ASC
    LIMIT ${limit}
  `)
  const selected: CompactedPostRow[] = []
  let remaining = currentBytes
  for (const candidate of candidates) {
    if (remaining <= maxBytes) break
    selected.push(candidate)
    remaining -= candidate.projectionBytes
  }
  return selected
}

function blobReferencesForRows(
  rows: readonly CompactedPostRow[],
): BlobReference[] {
  const references = new Map<string, BlobReference>()
  for (const row of rows) {
    for (const ref of parseBlobRefsForCompaction(row.blobRefsJson)) {
      const key = blobCacheKey(row.did, ref.cid)
      references.set(key, { did: row.did, cid: ref.cid })
    }
  }
  return [...references.values()]
}

function parseBlobRefsForCompaction(blobRefsJson: string): BlobRef[] {
  try {
    const parsed: unknown = JSON.parse(blobRefsJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is BlobRef =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { cid?: unknown }).cid === 'string',
    )
  } catch {
    return []
  }
}

async function selectPosts(
  db: Pick<SqliteDb, 'all'>,
  condition: SQL,
): Promise<CompactedPostRow[]> {
  return db.all<CompactedPostRow>(sql`
    SELECT uri, did, blobRefsJson, projectionBytes FROM post WHERE ${condition}
  `)
}

async function queueBlobCacheEvictions(
  db: Pick<SqliteDb, 'run'>,
  keys: readonly string[],
  queuedAt: string,
): Promise<void> {
  for (const key of keys) {
    await db.run(sql`
      INSERT INTO blob_cache_eviction (key, queuedAt)
      VALUES (${key}, ${queuedAt})
      ON CONFLICT(key) DO NOTHING
    `)
  }
}

async function replacePostBlobRefs(
  db: Pick<SqliteDb, 'run'>,
  uri: string,
  did: string,
  refs: readonly BlobRef[],
): Promise<void> {
  await db.run(sql`DELETE FROM post_blob_ref WHERE uri = ${uri}`)
  for (const cid of new Set(refs.map((ref) => ref.cid))) {
    await db.run(sql`
      INSERT INTO post_blob_ref (uri, did, cid)
      VALUES (${uri}, ${did}, ${cid})
    `)
  }
}

async function queueOrphanedPostBlobs(
  db: Pick<SqliteDb, 'get' | 'run'>,
  rows: readonly CompactedPostRow[],
  queuedAt: string,
): Promise<void> {
  const keys: string[] = []
  for (const reference of blobReferencesForRows(rows)) {
    const remaining = await db.get<{ found: number }>(sql`
      SELECT EXISTS(
        SELECT 1 FROM post_blob_ref
        WHERE did = ${reference.did} AND cid = ${reference.cid}
      ) AS found
    `)
    if (remaining.found === 0) {
      keys.push(blobCacheKey(reference.did, reference.cid))
    }
  }
  await queueBlobCacheEvictions(db, keys, queuedAt)
}

async function hasCompactionWork(
  db: Pick<SqliteDb, 'get'>,
  cutoff: string,
  maxBytes: number,
): Promise<boolean> {
  const result = await db.get<{ hasWork: number }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM post WHERE retainedAt <= ${cutoff}
      UNION ALL SELECT 1 FROM sync_cursor WHERE updatedAt <= ${cutoff}
      UNION ALL SELECT 1 FROM space_sync_cursor WHERE updatedAt <= ${cutoff}
      UNION ALL SELECT 1 FROM space_sync_stage WHERE updatedAt <= ${cutoff}
      UNION ALL SELECT 1 FROM space_sync_pending_verification WHERE updatedAt <= ${cutoff}
      UNION ALL SELECT 1 FROM projection_retention_metadata
      WHERE key = ${PROJECTION_BYTES_METADATA_KEY} AND value > ${maxBytes}
      UNION ALL SELECT 1 FROM blob_cache_eviction
    ) AS hasWork
  `)
  return result.hasWork === 1
}

async function markPendingVerification(
  db: Pick<SqliteDb, 'insert'>,
  input: SpaceSyncStagePage,
): Promise<void> {
  await db
    .insert(spaceSyncPendingVerificationTbl)
    .values({
      spaceUri: input.spaceUri,
      did: input.did,
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        spaceSyncPendingVerificationTbl.spaceUri,
        spaceSyncPendingVerificationTbl.did,
      ],
      set: { updatedAt: input.updatedAt },
    })
}

/** Migrate the materialized record index and its checkpointed sync state. */
export async function migrateRecordSqliteDb(db: SqliteDb): Promise<void> {
  await db._initialized
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS post (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      sortAt TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
      retainedAt TEXT NOT NULL,
      projectionBytes INTEGER NOT NULL,
      recordJson TEXT NOT NULL,
      blobRefsJson TEXT NOT NULL
    )
  `)
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS post_sort_at_uri_idx ON post(sortAt, uri)
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS post_boundary (
      uri TEXT NOT NULL,
      boundary TEXT NOT NULL,
      PRIMARY KEY (uri, boundary),
      FOREIGN KEY (uri) REFERENCES post(uri) ON DELETE CASCADE
    )
  `)
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS post_boundary_boundary_uri_idx
      ON post_boundary(boundary, uri)
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS sync_cursor (
      did TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS space_sync_cursor (
      spaceUri TEXT NOT NULL,
      did TEXT NOT NULL,
      cursor TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (spaceUri, did)
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS space_sync_stage (
      spaceUri TEXT NOT NULL,
      did TEXT NOT NULL,
      uri TEXT NOT NULL,
      boundary TEXT NOT NULL,
      deleted INTEGER NOT NULL,
      cid TEXT,
      sortAt TEXT,
      indexedAt TEXT,
      recordJson TEXT,
      blobRefsJson TEXT,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (spaceUri, did, uri)
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS space_sync_pending_verification (
      spaceUri TEXT NOT NULL,
      did TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (spaceUri, did)
    )
  `)
  await addRetentionColumns(db)
  await migratePostBlobRefs(db)
  await migrateProjectionByteMetadata(db)
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS post_retained_at_uri_idx ON post(retainedAt, uri)
  `)
  secureSqliteArtifacts(db)
}

async function migratePostBlobRefs(db: SqliteDb): Promise<void> {
  const existed = await sqliteTableExists(db, 'post_blob_ref')
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS post_blob_ref (
      uri TEXT NOT NULL,
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      PRIMARY KEY (uri, cid),
      FOREIGN KEY (uri) REFERENCES post(uri) ON DELETE CASCADE
    )
  `)
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS post_blob_ref_did_cid_idx
      ON post_blob_ref(did, cid)
  `)
  if (existed) return
  const rows = await db.all<CompactedPostRow>(sql`
    SELECT uri, did, blobRefsJson, projectionBytes FROM post
  `)
  for (const row of rows) {
    await replacePostBlobRefs(
      db,
      row.uri,
      row.did,
      parseBlobRefsForCompaction(row.blobRefsJson),
    )
  }
}

async function migrateProjectionByteMetadata(db: SqliteDb): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS projection_retention_metadata (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS blob_cache_eviction (
      key TEXT PRIMARY KEY,
      queuedAt TEXT NOT NULL
    )
  `)
  await db.run(sql`
    INSERT OR IGNORE INTO projection_retention_metadata (key, value)
    SELECT ${PROJECTION_BYTES_METADATA_KEY}, COALESCE(SUM(projectionBytes), 0)
    FROM post
  `)
  await db.run(
    sql.raw(`
    CREATE TRIGGER IF NOT EXISTS post_projection_bytes_insert
    AFTER INSERT ON post
    BEGIN
      UPDATE projection_retention_metadata
      SET value = value + NEW.projectionBytes
      WHERE key = '${PROJECTION_BYTES_METADATA_KEY}';
    END
  `),
  )
  await db.run(
    sql.raw(`
    CREATE TRIGGER IF NOT EXISTS post_projection_bytes_update
    AFTER UPDATE OF projectionBytes ON post
    BEGIN
      UPDATE projection_retention_metadata
      SET value = value - OLD.projectionBytes + NEW.projectionBytes
      WHERE key = '${PROJECTION_BYTES_METADATA_KEY}';
    END
  `),
  )
  await db.run(
    sql.raw(`
    CREATE TRIGGER IF NOT EXISTS post_projection_bytes_delete
    AFTER DELETE ON post
    BEGIN
      UPDATE projection_retention_metadata
      SET value = value - OLD.projectionBytes
      WHERE key = '${PROJECTION_BYTES_METADATA_KEY}';
    END
  `),
  )
}

async function addRetentionColumns(db: SqliteDb): Promise<void> {
  const now = new Date().toISOString()
  await addColumnIfMissing(
    db,
    'post',
    'retainedAt',
    `TEXT NOT NULL DEFAULT '${now}'`,
  )
  await addColumnIfMissing(
    db,
    'post',
    'projectionBytes',
    'INTEGER NOT NULL DEFAULT 0',
  )
  await db.run(sql`
    UPDATE post
    SET projectionBytes = length(CAST(uri AS BLOB)) + length(CAST(did AS BLOB))
      + length(CAST(cid AS BLOB)) + length(CAST(sortAt AS BLOB))
      + length(CAST(indexedAt AS BLOB)) + length(CAST(recordJson AS BLOB))
      + length(CAST(blobRefsJson AS BLOB))
    WHERE projectionBytes = 0
  `)
  await addColumnIfMissing(
    db,
    'space_sync_stage',
    'updatedAt',
    `TEXT NOT NULL DEFAULT '${now}'`,
  )
  await addColumnIfMissing(
    db,
    'space_sync_pending_verification',
    'updatedAt',
    `TEXT NOT NULL DEFAULT '${now}'`,
  )
}

async function addColumnIfMissing(
  db: SqliteDb,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await db.all<{ name: string }>(
    sql.raw(`PRAGMA table_info(${table})`),
  )
  if (columns.some((entry) => entry.name === column)) return
  await db.run(
    sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`),
  )
}

/** Migrate durable enrollment and completed space-membership snapshots. */
export async function migrateMembershipSqliteDb(db: SqliteDb): Promise<void> {
  await db._initialized
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS enrolled_actor (
      did TEXT PRIMARY KEY,
      boundariesJson TEXT NOT NULL,
      enrolledAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS space_member_snapshot (
      boundary TEXT NOT NULL,
      did TEXT NOT NULL,
      custody TEXT NOT NULL,
      host TEXT,
      PRIMARY KEY (boundary, did)
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS feedgen_membership_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  secureSqliteArtifacts(db)
}

/**
 * Carry forward membership baselines from a legacy one-file store exactly
 * once. Cursors are intentionally not copied: they remain co-durable with
 * the materialized records in the record store.
 */
export async function importLegacyMembershipSnapshots(
  recordDb: SqliteDb,
  membershipDb: SqliteDb,
): Promise<void> {
  if (recordDb === membershipDb) return
  const marker = await membershipDb.all<{ value: string }>(sql`
    SELECT value
    FROM feedgen_membership_metadata
    WHERE key = ${LEGACY_MEMBERSHIP_IMPORT_KEY}
  `)
  if (marker.length > 0) return

  const [hasEnrolledActors, hasSpaceMembers] = await Promise.all([
    sqliteTableExists(recordDb, 'enrolled_actor'),
    sqliteTableExists(recordDb, 'space_member_snapshot'),
  ])
  const [actors, members] = await Promise.all([
    hasEnrolledActors
      ? recordDb.select().from(enrolledActorTbl)
      : Promise.resolve([]),
    hasSpaceMembers
      ? recordDb.select().from(spaceMemberSnapshotTbl)
      : Promise.resolve([]),
  ])

  await membershipDb.transaction(async (tx) => {
    if (actors.length > 0) {
      await tx.insert(enrolledActorTbl).values(actors).onConflictDoNothing()
    }
    for (
      let offset = 0;
      offset < members.length;
      offset += SPACE_MEMBER_INSERT_CHUNK_SIZE
    ) {
      await tx
        .insert(spaceMemberSnapshotTbl)
        .values(members.slice(offset, offset + SPACE_MEMBER_INSERT_CHUNK_SIZE))
        .onConflictDoNothing()
    }
    await tx.run(sql`
      INSERT INTO feedgen_membership_metadata (key, value)
      VALUES (${LEGACY_MEMBERSHIP_IMPORT_KEY}, '1')
      ON CONFLICT(key) DO NOTHING
    `)
  })
}

/**
 * Backwards-compatible all-in-one migration for direct store construction.
 * Production opens the record and membership databases independently.
 */
export async function migrateSqliteDb(db: SqliteDb): Promise<void> {
  await migrateRecordSqliteDb(db)
  await migrateMembershipSqliteDb(db)
}

async function sqliteTableExists(
  db: SqliteDb,
  table: string,
): Promise<boolean> {
  const rows = await db.all<{ name: string }>(sql`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ${table}
  `)
  return rows.length > 0
}

export class SqliteFeedgenStore implements FeedgenStore {
  private readonly recordWrites = new SqliteWriteQueue()
  private readonly membershipWrites = new SqliteWriteQueue()
  private readonly retention: Required<ProjectionRetentionOptions> | undefined

  constructor(
    private readonly recordDb: SqliteDb,
    private readonly membershipDb: SqliteDb = recordDb,
    retention?: ProjectionRetentionOptions,
  ) {
    this.retention = retention
      ? {
          maxAgeMs: retention.maxAgeMs,
          maxBytes: retention.maxBytes,
          batchSize: retention.batchSize ?? DEFAULT_COMPACTION_BATCH_SIZE,
          now: retention.now ?? Date.now,
        }
      : undefined
  }

  private writeRecord<T>(operation: () => Promise<T>): Promise<T> {
    return this.recordWrites.run(operation)
  }

  private writeMembership<T>(operation: () => Promise<T>): Promise<T> {
    return (
      this.membershipDb === this.recordDb
        ? this.recordWrites
        : this.membershipWrites
    ).run(operation)
  }

  async upsertPost(input: PostUpsert): Promise<void> {
    const retainedAt = this.retainedAt()
    const projectionBytes = serializedPostBytes(input)
    await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const replaced = await selectPosts(tx, sql`uri = ${input.uri}`)
        await tx
          .insert(postTbl)
          .values({
            uri: input.uri,
            did: input.did,
            cid: input.cid,
            sortAt: input.sortAt,
            indexedAt: input.indexedAt,
            retainedAt,
            projectionBytes,
            recordJson: JSON.stringify(input.record),
            blobRefsJson: JSON.stringify(input.blobRefs),
          })
          .onConflictDoUpdate({
            target: postTbl.uri,
            set: {
              did: input.did,
              cid: input.cid,
              sortAt: input.sortAt,
              indexedAt: input.indexedAt,
              retainedAt,
              projectionBytes,
              recordJson: JSON.stringify(input.record),
              blobRefsJson: JSON.stringify(input.blobRefs),
            },
          })
        await replacePostBlobRefs(tx, input.uri, input.did, input.blobRefs)
        await this.queuePostBlobs(tx, replaced)
        await tx
          .delete(postBoundaryTbl)
          .where(eq(postBoundaryTbl.uri, input.uri))
        if (input.boundaries.length > 0) {
          await tx.insert(postBoundaryTbl).values(
            input.boundaries.map((boundary) => ({
              uri: input.uri,
              boundary,
            })),
          )
        }
      }),
    )
    await this.compactProjection()
  }

  async deletePost(uri: string): Promise<void> {
    await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const rows = await selectPosts(tx, sql`uri = ${uri}`)
        await tx.delete(postTbl).where(eq(postTbl.uri, uri))
        await this.queuePostBlobs(tx, rows)
      }),
    )
  }

  async deletePostsByDid(did: string): Promise<number> {
    // FK ON DELETE CASCADE removes the matching post_boundary rows.
    const res = await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const rows = await selectPosts(tx, sql`did = ${did}`)
        const deleted = await tx.delete(postTbl).where(eq(postTbl.did, did))
        await this.queuePostBlobs(tx, rows)
        return deleted
      }),
    )
    return res.rowsAffected
  }

  async deletePostsByDidBoundary(
    did: string,
    boundary: string,
  ): Promise<number> {
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        // Delete posts for which the removed boundary is the last one. Testing
        // for that boundary before deletion keeps pre-existing boundaryless
        // posts out of scope without materializing every URI into SQL binds.
        const deleteCondition = and(
          eq(postTbl.did, did),
          sql`EXISTS (
            SELECT 1 FROM post_boundary target
            WHERE target.uri = ${postTbl.uri}
              AND target.boundary = ${boundary}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM post_boundary other
            WHERE other.uri = ${postTbl.uri}
              AND other.boundary <> ${boundary}
          )`,
        )
        const rows = await selectPosts(
          tx,
          sql`did = ${did} AND EXISTS (
              SELECT 1 FROM post_boundary target
              WHERE target.uri = post.uri AND target.boundary = ${boundary}
            ) AND NOT EXISTS (
              SELECT 1 FROM post_boundary other
              WHERE other.uri = post.uri AND other.boundary <> ${boundary}
            )`,
        )
        const deleted = await tx.delete(postTbl).where(deleteCondition)
        await this.queuePostBlobs(tx, rows)

        // Multi-boundary posts survived the first statement; remove only their
        // lost boundary membership with a set-based author filter.
        await tx.delete(postBoundaryTbl).where(
          and(
            eq(postBoundaryTbl.boundary, boundary),
            sql`EXISTS (
            SELECT 1 FROM post authored
            WHERE authored.uri = ${postBoundaryTbl.uri}
              AND authored.did = ${did}
          )`,
          ),
        )
        return deleted.rowsAffected
      }),
    )
  }

  async deleteActorBoundaryStateGuarded(
    spaceUri: string,
    did: string,
    boundary: string,
    shouldCommit: () => boolean,
  ): Promise<GuardedBoundaryDeleteResult> {
    try {
      return await this.writeRecord(() =>
        this.recordDb.transaction(async (tx) => {
          const cursorDelete = await tx
            .delete(spaceSyncCursorTbl)
            .where(
              and(
                eq(spaceSyncCursorTbl.spaceUri, spaceUri),
                eq(spaceSyncCursorTbl.did, did),
              ),
            )
          await tx
            .delete(spaceSyncStageTbl)
            .where(
              and(
                eq(spaceSyncStageTbl.spaceUri, spaceUri),
                eq(spaceSyncStageTbl.did, did),
              ),
            )
          await tx
            .delete(spaceSyncPendingVerificationTbl)
            .where(
              and(
                eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri),
                eq(spaceSyncPendingVerificationTbl.did, did),
              ),
            )
          const rows = await selectPosts(
            tx,
            sql`did = ${did} AND EXISTS (
                SELECT 1 FROM post_boundary target
                WHERE target.uri = post.uri AND target.boundary = ${boundary}
              ) AND NOT EXISTS (
                SELECT 1 FROM post_boundary other
                WHERE other.uri = post.uri AND other.boundary <> ${boundary}
              )`,
          )
          const postDelete = await tx.delete(postTbl).where(
            and(
              eq(postTbl.did, did),
              sql`EXISTS (
              SELECT 1 FROM post_boundary target
              WHERE target.uri = ${postTbl.uri}
                AND target.boundary = ${boundary}
            )`,
              sql`NOT EXISTS (
              SELECT 1 FROM post_boundary other
              WHERE other.uri = ${postTbl.uri}
                AND other.boundary <> ${boundary}
            )`,
            ),
          )
          await this.queuePostBlobs(tx, rows)
          await tx.delete(postBoundaryTbl).where(
            and(
              eq(postBoundaryTbl.boundary, boundary),
              sql`EXISTS (
              SELECT 1 FROM post authored
              WHERE authored.uri = ${postBoundaryTbl.uri}
                AND authored.did = ${did}
            )`,
            ),
          )
          if (!shouldCommit()) throw new GuardedBoundaryDeleteAbortedError()
          return {
            committed: true,
            posts: postDelete.rowsAffected,
            spaceCursors: cursorDelete.rowsAffected,
          }
        }),
      )
    } catch (err) {
      if (err instanceof GuardedBoundaryDeleteAbortedError) {
        return { committed: false, posts: 0, spaceCursors: 0 }
      }
      throw err
    }
  }

  async listIndexedBoundaries(): Promise<string[]> {
    const rows = await this.recordDb
      .selectDistinct({ boundary: postBoundaryTbl.boundary })
      .from(postBoundaryTbl)
      .orderBy(asc(postBoundaryTbl.boundary))
    return rows.map((row) => row.boundary)
  }

  async deletePostsByBoundary(boundary: string): Promise<number> {
    // FK ON DELETE CASCADE removes every boundary row for matching posts.
    // Keep the selection in SQL so a large space never becomes an unbounded
    // application-side URI list or exceeds the backend's bind limit.
    const res = await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const condition = sql`EXISTS (
          SELECT 1 FROM post_boundary scoped
          WHERE scoped.uri = post.uri AND scoped.boundary = ${boundary}
        )`
        const rows = await selectPosts(tx, condition)
        const deleted = await tx.delete(postTbl).where(sql`EXISTS (
          SELECT 1 FROM post_boundary scoped
          WHERE scoped.uri = ${postTbl.uri}
            AND scoped.boundary = ${boundary}
        )`)
        await this.queuePostBlobs(tx, rows)
        return deleted
      }),
    )
    return res.rowsAffected
  }

  async deleteCursor(did: string): Promise<number> {
    const res = await this.writeRecord(() =>
      this.recordDb.delete(syncCursorTbl).where(eq(syncCursorTbl.did, did)),
    )
    return res.rowsAffected
  }

  async deleteSpaceCursor(spaceUri: string, did: string): Promise<number> {
    const res = await this.writeRecord(() =>
      this.recordDb
        .delete(spaceSyncCursorTbl)
        .where(
          and(
            eq(spaceSyncCursorTbl.spaceUri, spaceUri),
            eq(spaceSyncCursorTbl.did, did),
          ),
        ),
    )
    return res.rowsAffected
  }

  async deleteSpaceCursors(did: string): Promise<number> {
    const res = await this.writeRecord(() =>
      this.recordDb
        .delete(spaceSyncCursorTbl)
        .where(eq(spaceSyncCursorTbl.did, did)),
    )
    return res.rowsAffected
  }

  async deleteSpaceCursorsBySpace(spaceUri: string): Promise<number> {
    const res = await this.writeRecord(() =>
      this.recordDb
        .delete(spaceSyncCursorTbl)
        .where(eq(spaceSyncCursorTbl.spaceUri, spaceUri)),
    )
    return res.rowsAffected
  }

  async stageSpaceSyncPage(input: SpaceSyncStagePage): Promise<void> {
    await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        for (const mutation of input.mutations) {
          if (mutation.kind === 'delete') {
            await tx
              .insert(spaceSyncStageTbl)
              .values({
                spaceUri: input.spaceUri,
                did: input.did,
                uri: mutation.uri,
                boundary: input.boundary,
                deleted: true,
                cid: null,
                sortAt: null,
                indexedAt: null,
                recordJson: null,
                blobRefsJson: null,
                updatedAt: input.updatedAt,
              })
              .onConflictDoUpdate({
                target: [
                  spaceSyncStageTbl.spaceUri,
                  spaceSyncStageTbl.did,
                  spaceSyncStageTbl.uri,
                ],
                set: {
                  boundary: input.boundary,
                  deleted: true,
                  cid: null,
                  sortAt: null,
                  indexedAt: null,
                  recordJson: null,
                  blobRefsJson: null,
                  updatedAt: input.updatedAt,
                },
              })
            continue
          }

          const { post } = mutation
          await tx
            .insert(spaceSyncStageTbl)
            .values({
              spaceUri: input.spaceUri,
              did: input.did,
              uri: post.uri,
              boundary: input.boundary,
              deleted: false,
              cid: post.cid,
              sortAt: post.sortAt,
              indexedAt: post.indexedAt,
              recordJson: JSON.stringify(post.record),
              blobRefsJson: JSON.stringify(post.blobRefs),
              updatedAt: input.updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                spaceSyncStageTbl.spaceUri,
                spaceSyncStageTbl.did,
                spaceSyncStageTbl.uri,
              ],
              set: {
                boundary: input.boundary,
                deleted: false,
                cid: post.cid,
                sortAt: post.sortAt,
                indexedAt: post.indexedAt,
                recordJson: JSON.stringify(post.record),
                blobRefsJson: JSON.stringify(post.blobRefs),
                updatedAt: input.updatedAt,
              },
            })
        }
        if (input.nextCursor !== undefined) {
          await tx
            .insert(spaceSyncCursorTbl)
            .values({
              spaceUri: input.spaceUri,
              did: input.did,
              cursor: input.nextCursor,
              updatedAt: input.updatedAt,
            })
            .onConflictDoUpdate({
              target: [spaceSyncCursorTbl.spaceUri, spaceSyncCursorTbl.did],
              set: { cursor: input.nextCursor, updatedAt: input.updatedAt },
            })
        }
        if (input.nextCursor === undefined) {
          await markPendingVerification(tx, input)
        }
      }),
    )
  }

  async promoteSpaceSyncStage(spaceUri: string, did: string): Promise<void> {
    await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const stages = await tx
          .select()
          .from(spaceSyncStageTbl)
          .where(
            and(
              eq(spaceSyncStageTbl.spaceUri, spaceUri),
              eq(spaceSyncStageTbl.did, did),
            ),
          )
        for (const stage of stages) {
          if (stage.deleted) {
            const rows = await selectPosts(tx, sql`uri = ${stage.uri}`)
            await tx.delete(postTbl).where(eq(postTbl.uri, stage.uri))
            await this.queuePostBlobs(tx, rows)
            continue
          }
          const post = stageRowToPost(stage)
          const replaced = await selectPosts(tx, sql`uri = ${post.uri}`)
          await tx
            .insert(postTbl)
            .values({
              uri: post.uri,
              did: post.did,
              cid: post.cid,
              sortAt: post.sortAt,
              indexedAt: post.indexedAt,
              retainedAt: this.retainedAt(),
              projectionBytes: serializedPostBytes(post),
              recordJson: JSON.stringify(post.record),
              blobRefsJson: JSON.stringify(post.blobRefs),
            })
            .onConflictDoUpdate({
              target: postTbl.uri,
              set: {
                did: post.did,
                cid: post.cid,
                sortAt: post.sortAt,
                indexedAt: post.indexedAt,
                retainedAt: this.retainedAt(),
                projectionBytes: serializedPostBytes(post),
                recordJson: JSON.stringify(post.record),
                blobRefsJson: JSON.stringify(post.blobRefs),
              },
            })
          await replacePostBlobRefs(tx, post.uri, post.did, post.blobRefs)
          await this.queuePostBlobs(tx, replaced)
          await tx
            .delete(postBoundaryTbl)
            .where(eq(postBoundaryTbl.uri, post.uri))
          await tx.insert(postBoundaryTbl).values({
            uri: post.uri,
            boundary: stage.boundary,
          })
        }
        await tx
          .delete(spaceSyncStageTbl)
          .where(
            and(
              eq(spaceSyncStageTbl.spaceUri, spaceUri),
              eq(spaceSyncStageTbl.did, did),
            ),
          )
        await tx
          .delete(spaceSyncPendingVerificationTbl)
          .where(
            and(
              eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri),
              eq(spaceSyncPendingVerificationTbl.did, did),
            ),
          )
      }),
    )
    await this.compactProjection()
  }

  async resetPendingSpaceSyncState(
    spaceUri: string,
    did: string,
  ): Promise<boolean> {
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const pending = await tx
          .delete(spaceSyncPendingVerificationTbl)
          .where(
            and(
              eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri),
              eq(spaceSyncPendingVerificationTbl.did, did),
            ),
          )
        if (pending.rowsAffected === 0) return false
        await tx
          .delete(spaceSyncStageTbl)
          .where(
            and(
              eq(spaceSyncStageTbl.spaceUri, spaceUri),
              eq(spaceSyncStageTbl.did, did),
            ),
          )
        await tx
          .delete(spaceSyncCursorTbl)
          .where(
            and(
              eq(spaceSyncCursorTbl.spaceUri, spaceUri),
              eq(spaceSyncCursorTbl.did, did),
            ),
          )
        return true
      }),
    )
  }

  async resetSpaceSyncState(spaceUri: string, did: string): Promise<void> {
    await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        await tx
          .delete(spaceSyncPendingVerificationTbl)
          .where(
            and(
              eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri),
              eq(spaceSyncPendingVerificationTbl.did, did),
            ),
          )
        await tx
          .delete(spaceSyncStageTbl)
          .where(
            and(
              eq(spaceSyncStageTbl.spaceUri, spaceUri),
              eq(spaceSyncStageTbl.did, did),
            ),
          )
        await tx
          .delete(spaceSyncCursorTbl)
          .where(
            and(
              eq(spaceSyncCursorTbl.spaceUri, spaceUri),
              eq(spaceSyncCursorTbl.did, did),
            ),
          )
      }),
    )
  }

  async deleteSpaceSyncStage(spaceUri: string, did: string): Promise<number> {
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const deleted = await tx
          .delete(spaceSyncStageTbl)
          .where(
            and(
              eq(spaceSyncStageTbl.spaceUri, spaceUri),
              eq(spaceSyncStageTbl.did, did),
            ),
          )
        await tx
          .delete(spaceSyncPendingVerificationTbl)
          .where(
            and(
              eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri),
              eq(spaceSyncPendingVerificationTbl.did, did),
            ),
          )
        return deleted.rowsAffected
      }),
    )
  }

  async deleteSpaceSyncStages(did: string): Promise<number> {
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const deleted = await tx
          .delete(spaceSyncStageTbl)
          .where(eq(spaceSyncStageTbl.did, did))
        await tx
          .delete(spaceSyncPendingVerificationTbl)
          .where(eq(spaceSyncPendingVerificationTbl.did, did))
        return deleted.rowsAffected
      }),
    )
  }

  async deleteSpaceSyncStagesBySpace(spaceUri: string): Promise<number> {
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const deleted = await tx
          .delete(spaceSyncStageTbl)
          .where(eq(spaceSyncStageTbl.spaceUri, spaceUri))
        await tx
          .delete(spaceSyncPendingVerificationTbl)
          .where(eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri))
        return deleted.rowsAffected
      }),
    )
  }

  async getPost(uri: string): Promise<IndexedPost | null> {
    const rows = await this.recordDb
      .select()
      .from(postTbl)
      .where(
        this.retention
          ? and(
              eq(postTbl.uri, uri),
              gt(postTbl.retainedAt, this.retentionCutoff()),
            )
          : eq(postTbl.uri, uri),
      )
      .limit(1)
    if (rows.length === 0) return null
    const boundaries = await this.recordDb
      .select({ boundary: postBoundaryTbl.boundary })
      .from(postBoundaryTbl)
      .where(eq(postBoundaryTbl.uri, uri))
    return rowToPost(
      rows[0],
      boundaries.map((b) => b.boundary),
    )
  }

  async listPostsByBoundary(opts: ListPostsOpts): Promise<ListPostsResult> {
    const decoded = opts.cursor ? decodeCursor(opts.cursor) : null
    const cursorCondition = decoded
      ? or(
          lt(postTbl.sortAt, decoded.sortAt),
          and(
            eq(postTbl.sortAt, decoded.sortAt),
            sql`${postTbl.uri} > ${decoded.uri}`,
          ),
        )
      : undefined
    const boundaryCondition = eq(postBoundaryTbl.boundary, opts.boundary)
    const retentionCondition = this.retention
      ? gt(postTbl.retainedAt, this.retentionCutoff())
      : undefined
    const rows = await this.recordDb
      .select({
        uri: postTbl.uri,
        did: postTbl.did,
        cid: postTbl.cid,
        sortAt: postTbl.sortAt,
        indexedAt: postTbl.indexedAt,
        recordJson: postTbl.recordJson,
        blobRefsJson: postTbl.blobRefsJson,
      })
      .from(postTbl)
      .innerJoin(postBoundaryTbl, eq(postBoundaryTbl.uri, postTbl.uri))
      .where(
        cursorCondition
          ? and(boundaryCondition, cursorCondition, retentionCondition)
          : and(boundaryCondition, retentionCondition),
      )
      .orderBy(desc(postTbl.sortAt), asc(postTbl.uri))
      .limit(opts.limit)
    if (rows.length === 0) return { posts: [] }
    const boundariesByUri = await this.fetchBoundaries(rows.map((r) => r.uri))
    const posts = rows.map((row) =>
      rowToPost(row, boundariesByUri.get(row.uri) ?? []),
    )
    const last = rows[rows.length - 1]
    return {
      posts,
      cursor:
        rows.length === opts.limit
          ? encodeCursor(last.sortAt, last.uri)
          : undefined,
    }
  }

  /** Remove one bounded batch of expired or over-budget serving state. */
  async compactProjection(): Promise<ProjectionCompactionBatch> {
    if (!this.retention) return this.drainBlobCacheEvictions()
    const retention = this.retention
    const cutoff = this.retentionCutoff()
    const limit = retention.batchSize
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const expired = await tx.all<CompactedPostRow>(sql`
          SELECT uri, did, blobRefsJson, projectionBytes FROM post
          WHERE retainedAt <= ${cutoff}
          ORDER BY retainedAt ASC, uri ASC
          LIMIT ${limit}
        `)
        const expiredPosts = await deletePostRows(tx, expired)
        const current = await tx.get<{ bytes: number }>(sql`
          SELECT value AS bytes FROM projection_retention_metadata
          WHERE key = ${PROJECTION_BYTES_METADATA_KEY}
        `)
        const byteEvictions = await evictOverBudgetPosts(
          tx,
          Math.max(0, Number(current.bytes)),
          retention.maxBytes,
          limit - expiredPosts,
        )
        await deletePostRows(tx, byteEvictions)
        await this.queuePostBlobs(tx, [...expired, ...byteEvictions])
        const pendingBlobCacheKeys = await tx.all<{ key: string }>(sql`
          SELECT key FROM blob_cache_eviction
          ORDER BY queuedAt ASC, key ASC
          LIMIT ${limit}
        `)
        const syncCursors = await tx.run(sql`
          DELETE FROM sync_cursor
          WHERE did IN (
            SELECT did FROM sync_cursor
            WHERE updatedAt <= ${cutoff}
            ORDER BY updatedAt ASC, did ASC
            LIMIT ${limit}
          )
        `)
        const spaceCursors = await tx.run(sql`
          DELETE FROM space_sync_cursor
          WHERE rowid IN (
            SELECT rowid FROM space_sync_cursor
            WHERE updatedAt <= ${cutoff}
            ORDER BY updatedAt ASC, spaceUri ASC, did ASC
            LIMIT ${limit}
          )
        `)
        const stagedRecords = await tx.run(sql`
          DELETE FROM space_sync_stage
          WHERE rowid IN (
            SELECT rowid FROM space_sync_stage
            WHERE updatedAt <= ${cutoff}
            ORDER BY updatedAt ASC, spaceUri ASC, did ASC, uri ASC
            LIMIT ${limit}
          )
        `)
        const pendingVerifications = await tx.run(sql`
          DELETE FROM space_sync_pending_verification
          WHERE rowid IN (
            SELECT rowid FROM space_sync_pending_verification
            WHERE updatedAt <= ${cutoff}
            ORDER BY updatedAt ASC, spaceUri ASC, did ASC
            LIMIT ${limit}
          )
        `)
        const hasMore = await hasCompactionWork(tx, cutoff, retention.maxBytes)
        return {
          posts: expiredPosts + byteEvictions.length,
          blobCacheEntries: pendingBlobCacheKeys.length,
          syncCursors: syncCursors.rowsAffected,
          spaceCursors: spaceCursors.rowsAffected,
          stagedRecords: stagedRecords.rowsAffected,
          pendingVerifications: pendingVerifications.rowsAffected,
          hasMore,
          blobCacheKeys: pendingBlobCacheKeys.map((entry) => entry.key),
        }
      }),
    )
  }

  async completeBlobCacheEvictions(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return
    await this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        for (const key of keys) {
          await tx.run(sql`DELETE FROM blob_cache_eviction WHERE key = ${key}`)
        }
      }),
    )
  }

  private async drainBlobCacheEvictions(): Promise<ProjectionCompactionBatch> {
    return this.writeRecord(() =>
      this.recordDb.transaction(async (tx) => {
        const keys = await tx.all<{ key: string }>(sql`
          SELECT key FROM blob_cache_eviction
          ORDER BY queuedAt ASC, key ASC
          LIMIT ${DEFAULT_COMPACTION_BATCH_SIZE}
        `)
        const more = await tx.get<{ hasMore: number }>(sql`
          SELECT EXISTS(
            SELECT 1 FROM blob_cache_eviction
            ORDER BY queuedAt ASC, key ASC
            LIMIT 1 OFFSET ${DEFAULT_COMPACTION_BATCH_SIZE}
          ) AS hasMore
        `)
        return {
          ...emptyCompactionResult(),
          blobCacheEntries: keys.length,
          blobCacheKeys: keys.map((entry) => entry.key),
          hasMore: more.hasMore === 1,
        }
      }),
    )
  }

  private async queuePostBlobs(
    db: Pick<SqliteDb, 'get' | 'run'>,
    rows: readonly CompactedPostRow[],
  ): Promise<void> {
    await queueOrphanedPostBlobs(db, rows, this.retainedAt())
  }

  private retainedAt(): string {
    return new Date(this.retention?.now() ?? Date.now()).toISOString()
  }

  private retentionCutoff(): string {
    if (!this.retention)
      throw new Error('projection retention is not configured')
    return new Date(
      this.retention.now() - this.retention.maxAgeMs,
    ).toISOString()
  }

  private async fetchBoundaries(
    uris: string[],
  ): Promise<Map<string, string[]>> {
    if (uris.length === 0) return new Map()
    const rows = await this.recordDb
      .select({
        uri: postBoundaryTbl.uri,
        boundary: postBoundaryTbl.boundary,
      })
      .from(postBoundaryTbl)
      .where(inArray(postBoundaryTbl.uri, uris))
    const result = new Map<string, string[]>()
    for (const r of rows) {
      const list = result.get(r.uri) ?? []
      list.push(r.boundary)
      result.set(r.uri, list)
    }
    return result
  }

  async upsertCursor(
    did: string,
    seq: number,
    updatedAt: string,
  ): Promise<void> {
    await this.writeRecord(() =>
      this.recordDb
        .insert(syncCursorTbl)
        .values({ did, seq, updatedAt })
        .onConflictDoUpdate({
          target: syncCursorTbl.did,
          set: { seq, updatedAt },
        }),
    )
  }

  async getCursor(did: string): Promise<number | null> {
    const rows = await this.recordDb
      .select({ seq: syncCursorTbl.seq })
      .from(syncCursorTbl)
      .where(eq(syncCursorTbl.did, did))
      .limit(1)
    return rows.length === 0 ? null : rows[0].seq
  }

  async upsertSpaceCursor(
    spaceUri: string,
    did: string,
    cursor: string,
    updatedAt: string,
  ): Promise<void> {
    await this.writeRecord(() =>
      this.recordDb
        .insert(spaceSyncCursorTbl)
        .values({ spaceUri, did, cursor, updatedAt })
        .onConflictDoUpdate({
          target: [spaceSyncCursorTbl.spaceUri, spaceSyncCursorTbl.did],
          set: { cursor, updatedAt },
        }),
    )
  }

  async getSpaceCursor(spaceUri: string, did: string): Promise<string | null> {
    const rows = await this.recordDb
      .select({ cursor: spaceSyncCursorTbl.cursor })
      .from(spaceSyncCursorTbl)
      .where(
        and(
          eq(spaceSyncCursorTbl.spaceUri, spaceUri),
          eq(spaceSyncCursorTbl.did, did),
        ),
      )
      .limit(1)
    return rows.length === 0 ? null : rows[0].cursor
  }

  async listSpaceMembers(boundary: string): Promise<SpaceMemberSnapshot[]> {
    const rows = await this.membershipDb
      .select({
        did: spaceMemberSnapshotTbl.did,
        custody: spaceMemberSnapshotTbl.custody,
        host: spaceMemberSnapshotTbl.host,
      })
      .from(spaceMemberSnapshotTbl)
      .where(eq(spaceMemberSnapshotTbl.boundary, boundary))
      .orderBy(asc(spaceMemberSnapshotTbl.did))
    return rows.map(({ did, custody, host }) => ({
      did,
      custody,
      ...(host === null ? {} : { host }),
    }))
  }

  async getCatalogBaseline(): Promise<CatalogBoundary[]> {
    const rows = await this.membershipDb
      .select({ value: membershipMetadataTbl.value })
      .from(membershipMetadataTbl)
      .where(eq(membershipMetadataTbl.key, CATALOG_BASELINE_KEY))
      .limit(1)
    if (rows.length === 0) return []
    return parseCatalogBaseline(rows[0].value)
  }

  async replaceCatalogBaseline(
    boundaries: readonly CatalogBoundary[],
  ): Promise<void> {
    const value = JSON.stringify(boundaries)
    await this.writeMembership(() =>
      this.membershipDb
        .insert(membershipMetadataTbl)
        .values({ key: CATALOG_BASELINE_KEY, value })
        .onConflictDoUpdate({
          target: membershipMetadataTbl.key,
          set: { value },
        }),
    )
  }

  async replaceSpaceMembers(
    boundary: string,
    members: SpaceMemberSnapshot[],
  ): Promise<void> {
    const uniqueMembers = [
      ...new Map(members.map((member) => [member.did, member])).values(),
    ]
    await this.writeMembership(() =>
      this.membershipDb.transaction(async (tx) => {
        await tx
          .delete(spaceMemberSnapshotTbl)
          .where(eq(spaceMemberSnapshotTbl.boundary, boundary))
        for (
          let offset = 0;
          offset < uniqueMembers.length;
          offset += SPACE_MEMBER_INSERT_CHUNK_SIZE
        ) {
          const chunk = uniqueMembers.slice(
            offset,
            offset + SPACE_MEMBER_INSERT_CHUNK_SIZE,
          )
          await tx.insert(spaceMemberSnapshotTbl).values(
            chunk.map((member) => ({
              boundary,
              did: member.did,
              custody: member.custody,
              host: member.host ?? null,
            })),
          )
        }
      }),
    )
  }

  async upsertEnrolledActor(input: EnrolledActorUpsert): Promise<void> {
    const boundariesJson = JSON.stringify(input.boundaries)
    await this.writeMembership(() =>
      this.membershipDb
        .insert(enrolledActorTbl)
        .values({
          did: input.did,
          boundariesJson,
          enrolledAt: input.enrolledAt,
          lastSeenAt: input.lastSeenAt,
        })
        .onConflictDoUpdate({
          target: enrolledActorTbl.did,
          set: {
            boundariesJson,
            enrolledAt: input.enrolledAt,
            lastSeenAt: input.lastSeenAt,
          },
        }),
    )
  }

  async getEnrolledActor(did: string): Promise<EnrolledActor | null> {
    const rows = await this.membershipDb
      .select()
      .from(enrolledActorTbl)
      .where(eq(enrolledActorTbl.did, did))
      .limit(1)
    if (rows.length === 0) return null
    return rowToEnrolledActor(rows[0])
  }

  async listEnrolledActors(): Promise<EnrolledActor[]> {
    const rows = await this.membershipDb.select().from(enrolledActorTbl)
    return rows.map(rowToEnrolledActor)
  }

  async deleteEnrolledActor(did: string): Promise<void> {
    await this.writeMembership(() =>
      this.membershipDb
        .delete(enrolledActorTbl)
        .where(eq(enrolledActorTbl.did, did)),
    )
  }

  async close(): Promise<void> {
    this.recordDb._client.close()
    this.recordDb._memoryAnchor?.close()
    if (this.membershipDb !== this.recordDb) {
      this.membershipDb._client.close()
      this.membershipDb._memoryAnchor?.close()
    }
  }
}

class GuardedBoundaryDeleteAbortedError extends Error {}

function rowToPost(
  row: {
    uri: string
    did: string
    cid: string
    sortAt: string
    indexedAt: string
    recordJson: string
    blobRefsJson: string
  },
  boundaries: string[],
): IndexedPost {
  return {
    uri: row.uri,
    did: row.did,
    cid: row.cid,
    sortAt: row.sortAt,
    indexedAt: row.indexedAt,
    record: JSON.parse(row.recordJson) as Record<string, unknown>,
    blobRefs: JSON.parse(row.blobRefsJson) as IndexedPost['blobRefs'],
    boundaries,
  }
}

function stageRowToPost(row: {
  uri: string
  did: string
  boundary: string
  deleted: boolean
  cid: string | null
  sortAt: string | null
  indexedAt: string | null
  recordJson: string | null
  blobRefsJson: string | null
}): PostUpsert {
  if (
    row.deleted ||
    row.cid === null ||
    row.sortAt === null ||
    row.indexedAt === null ||
    row.recordJson === null ||
    row.blobRefsJson === null
  ) {
    throw new Error(`invalid staged post ${row.uri}`)
  }
  return {
    uri: row.uri,
    did: row.did,
    cid: row.cid,
    sortAt: row.sortAt,
    indexedAt: row.indexedAt,
    record: JSON.parse(row.recordJson) as Record<string, unknown>,
    blobRefs: JSON.parse(row.blobRefsJson) as PostUpsert['blobRefs'],
    boundaries: [row.boundary],
  }
}

function parseCatalogBaseline(value: string): CatalogBoundary[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed))
    throw new Error('Invalid persisted boundary catalogue')
  return parsed as CatalogBoundary[]
}

function rowToEnrolledActor(row: {
  did: string
  boundariesJson: string
  enrolledAt: string
  lastSeenAt: string
}): EnrolledActor {
  return {
    did: row.did,
    boundaries: JSON.parse(row.boundariesJson) as string[],
    enrolledAt: row.enrolledAt,
    lastSeenAt: row.lastSeenAt,
  }
}
