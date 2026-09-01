import { Client, createClient } from '@libsql/client'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql'
import {
  enrolledActor as enrolledActorTbl,
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
  EnrolledActor,
  EnrolledActorUpsert,
  FeedgenStore,
  GuardedBoundaryDeleteResult,
  IndexedPost,
  ListPostsOpts,
  ListPostsResult,
  PostUpsert,
  SPACE_MEMBER_INSERT_CHUNK_SIZE,
  SpaceMemberSnapshot,
  SpaceSyncStagePage,
} from './types.js'

export type SqliteDb = LibSQLDatabase<typeof sqliteSchema> & {
  _client: Client
  _initialized: Promise<void>
}

const LEGACY_MEMBERSHIP_IMPORT_KEY = 'legacy-record-store-imported'

export function createSqliteDb(location: string): SqliteDb {
  const client = createClient({
    url: sqliteClientUrl(location),
  })
  const baseDb = drizzle({ client, schema: sqliteSchema })
  const db = baseDb as unknown as SqliteDb
  db._client = client
  db._initialized = (async () => {
    try {
      await db.run(sql.raw('PRAGMA journal_mode = WAL'))
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'SQLITE_BUSY') throw err
    }
    await db.run(sql.raw('PRAGMA foreign_keys = ON'))
  })()
  return db
}

function sqliteClientUrl(location: string): string {
  return location === ':memory:'
    ? ':memory:'
    : pathToFileURL(resolve(location)).href
}

/** Migrate the materialized record index and the cursors that checkpoint it. */
export async function migrateRecordSqliteDb(db: SqliteDb): Promise<void> {
  await db._initialized
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS post (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      sortAt TEXT NOT NULL,
      indexedAt TEXT NOT NULL,
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
      PRIMARY KEY (spaceUri, did, uri)
    )
  `)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS space_sync_pending_verification (
      spaceUri TEXT NOT NULL,
      did TEXT NOT NULL,
      PRIMARY KEY (spaceUri, did)
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
  constructor(
    private readonly recordDb: SqliteDb,
    private readonly membershipDb: SqliteDb = recordDb,
  ) {}

  async upsertPost(input: PostUpsert): Promise<void> {
    await this.recordDb.transaction(async (tx) => {
      await tx
        .insert(postTbl)
        .values({
          uri: input.uri,
          did: input.did,
          cid: input.cid,
          sortAt: input.sortAt,
          indexedAt: input.indexedAt,
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
            recordJson: JSON.stringify(input.record),
            blobRefsJson: JSON.stringify(input.blobRefs),
          },
        })
      await tx.delete(postBoundaryTbl).where(eq(postBoundaryTbl.uri, input.uri))
      if (input.boundaries.length > 0) {
        await tx.insert(postBoundaryTbl).values(
          input.boundaries.map((boundary) => ({
            uri: input.uri,
            boundary,
          })),
        )
      }
    })
  }

  async deletePost(uri: string): Promise<void> {
    await this.recordDb.delete(postTbl).where(eq(postTbl.uri, uri))
  }

  async deletePostsByDid(did: string): Promise<number> {
    // FK ON DELETE CASCADE removes the matching post_boundary rows.
    const res = await this.recordDb.delete(postTbl).where(eq(postTbl.did, did))
    return res.rowsAffected
  }

  async deletePostsByDidBoundary(
    did: string,
    boundary: string,
  ): Promise<number> {
    return this.recordDb.transaction(async (tx) => {
      // Delete posts for which the removed boundary is the last one. Testing
      // for that boundary before deletion keeps pre-existing boundaryless
      // posts out of scope without materializing every URI into SQL binds.
      const deleted = await tx.delete(postTbl).where(
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
    })
  }

  async deleteActorBoundaryStateGuarded(
    spaceUri: string,
    did: string,
    boundary: string,
    shouldCommit: () => boolean,
  ): Promise<GuardedBoundaryDeleteResult> {
    try {
      return await this.recordDb.transaction(async (tx) => {
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
      })
    } catch (err) {
      if (err instanceof GuardedBoundaryDeleteAbortedError) {
        return { committed: false, posts: 0, spaceCursors: 0 }
      }
      throw err
    }
  }

  async deletePostsByBoundary(boundary: string): Promise<number> {
    // FK ON DELETE CASCADE removes every boundary row for matching posts.
    // Keep the selection in SQL so a large space never becomes an unbounded
    // application-side URI list or exceeds the backend's bind limit.
    const res = await this.recordDb.delete(postTbl).where(sql`EXISTS (
      SELECT 1 FROM post_boundary scoped
      WHERE scoped.uri = ${postTbl.uri}
        AND scoped.boundary = ${boundary}
    )`)
    return res.rowsAffected
  }

  async deleteCursor(did: string): Promise<number> {
    const res = await this.recordDb
      .delete(syncCursorTbl)
      .where(eq(syncCursorTbl.did, did))
    return res.rowsAffected
  }

  async deleteSpaceCursor(spaceUri: string, did: string): Promise<number> {
    const res = await this.recordDb
      .delete(spaceSyncCursorTbl)
      .where(
        and(
          eq(spaceSyncCursorTbl.spaceUri, spaceUri),
          eq(spaceSyncCursorTbl.did, did),
        ),
      )
    return res.rowsAffected
  }

  async deleteSpaceCursors(did: string): Promise<number> {
    const res = await this.recordDb
      .delete(spaceSyncCursorTbl)
      .where(eq(spaceSyncCursorTbl.did, did))
    return res.rowsAffected
  }

  async deleteSpaceCursorsBySpace(spaceUri: string): Promise<number> {
    const res = await this.recordDb
      .delete(spaceSyncCursorTbl)
      .where(eq(spaceSyncCursorTbl.spaceUri, spaceUri))
    return res.rowsAffected
  }

  async stageSpaceSyncPage(input: SpaceSyncStagePage): Promise<void> {
    await this.db.transaction(async (tx) => {
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
        await tx
          .insert(spaceSyncPendingVerificationTbl)
          .values({ spaceUri: input.spaceUri, did: input.did })
          .onConflictDoNothing()
      }
    })
  }

  async promoteSpaceSyncStage(spaceUri: string, did: string): Promise<void> {
    await this.db.transaction(async (tx) => {
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
          await tx.delete(postTbl).where(eq(postTbl.uri, stage.uri))
          continue
        }
        const post = stageRowToPost(stage)
        await tx
          .insert(postTbl)
          .values({
            uri: post.uri,
            did: post.did,
            cid: post.cid,
            sortAt: post.sortAt,
            indexedAt: post.indexedAt,
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
              recordJson: JSON.stringify(post.record),
              blobRefsJson: JSON.stringify(post.blobRefs),
            },
          })
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
    })
  }

  async resetPendingSpaceSyncState(
    spaceUri: string,
    did: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
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
    })
  }

  async resetSpaceSyncState(spaceUri: string, did: string): Promise<void> {
    await this.db.transaction(async (tx) => {
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
    })
  }

  async deleteSpaceSyncStage(spaceUri: string, did: string): Promise<number> {
    return this.db.transaction(async (tx) => {
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
    })
  }

  async deleteSpaceSyncStages(did: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(spaceSyncStageTbl)
        .where(eq(spaceSyncStageTbl.did, did))
      await tx
        .delete(spaceSyncPendingVerificationTbl)
        .where(eq(spaceSyncPendingVerificationTbl.did, did))
      return deleted.rowsAffected
    })
  }

  async deleteSpaceSyncStagesBySpace(spaceUri: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(spaceSyncStageTbl)
        .where(eq(spaceSyncStageTbl.spaceUri, spaceUri))
      await tx
        .delete(spaceSyncPendingVerificationTbl)
        .where(eq(spaceSyncPendingVerificationTbl.spaceUri, spaceUri))
      return deleted.rowsAffected
    })
  }

  async getPost(uri: string): Promise<IndexedPost | null> {
    const rows = await this.recordDb
      .select()
      .from(postTbl)
      .where(eq(postTbl.uri, uri))
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
          ? and(eq(postBoundaryTbl.boundary, opts.boundary), cursorCondition)
          : eq(postBoundaryTbl.boundary, opts.boundary),
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
    await this.recordDb
      .insert(syncCursorTbl)
      .values({ did, seq, updatedAt })
      .onConflictDoUpdate({
        target: syncCursorTbl.did,
        set: { seq, updatedAt },
      })
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
    await this.recordDb
      .insert(spaceSyncCursorTbl)
      .values({ spaceUri, did, cursor, updatedAt })
      .onConflictDoUpdate({
        target: [spaceSyncCursorTbl.spaceUri, spaceSyncCursorTbl.did],
        set: { cursor, updatedAt },
      })
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

  async replaceSpaceMembers(
    boundary: string,
    members: SpaceMemberSnapshot[],
  ): Promise<void> {
    const uniqueMembers = [
      ...new Map(members.map((member) => [member.did, member])).values(),
    ]
    await this.membershipDb.transaction(async (tx) => {
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
    })
  }

  async upsertEnrolledActor(input: EnrolledActorUpsert): Promise<void> {
    const boundariesJson = JSON.stringify(input.boundaries)
    await this.membershipDb
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
      })
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
    await this.membershipDb
      .delete(enrolledActorTbl)
      .where(eq(enrolledActorTbl.did, did))
  }

  async close(): Promise<void> {
    this.recordDb._client.close()
    if (this.membershipDb !== this.recordDb) {
      this.membershipDb._client.close()
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
