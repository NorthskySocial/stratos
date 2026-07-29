import postgres from 'postgres'
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  pgEnrolledActor as enrolledActorTbl,
  pgPost as postTbl,
  pgPostBoundary as postBoundaryTbl,
  pgSyncCursor as syncCursorTbl,
} from './schema/postgres.js'
import { pgSchema } from './schema/index.js'
import {
  decodeCursor,
  encodeCursor,
  EnrolledActor,
  EnrolledActorUpsert,
  FeedgenStore,
  IndexedPost,
  ListPostsOpts,
  ListPostsResult,
  PostUpsert,
} from './types.js'

export type PgDb = PostgresJsDatabase<typeof pgSchema> & {
  _client: postgres.Sql
}

export function createPgDb(
  connectionString: string,
  schemaName?: string,
): PgDb {
  const client = postgres(connectionString, {
    max: 10,
    ...(schemaName ? { connection: { search_path: schemaName } } : {}),
  })
  const baseDb = drizzle({ client, schema: pgSchema })
  const db = baseDb as unknown as PgDb
  db._client = client
  return db
}

export async function migratePgDb(
  db: PgDb,
  schemaName?: string,
): Promise<void> {
  if (schemaName) {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`))
    await db.execute(sql.raw(`SET search_path TO "${schemaName}"`))
  }
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS post (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      "sortAt" TEXT NOT NULL,
      "indexedAt" TEXT NOT NULL,
      "recordJson" TEXT NOT NULL,
      "blobRefsJson" TEXT NOT NULL
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS post_sort_at_uri_idx ON post("sortAt", uri)
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS post_boundary (
      uri TEXT NOT NULL,
      boundary TEXT NOT NULL,
      PRIMARY KEY (uri, boundary),
      FOREIGN KEY (uri) REFERENCES post(uri) ON DELETE CASCADE
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS post_boundary_boundary_uri_idx
      ON post_boundary(boundary, uri)
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sync_cursor (
      did TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      "updatedAt" TEXT NOT NULL
    )
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS enrolled_actor (
      did TEXT PRIMARY KEY,
      "boundariesJson" TEXT NOT NULL,
      "enrolledAt" TEXT NOT NULL,
      "lastSeenAt" TEXT NOT NULL
    )
  `)
}

export class PgFeedgenStore implements FeedgenStore {
  constructor(private readonly db: PgDb) {}

  async upsertPost(input: PostUpsert): Promise<void> {
    await this.db.transaction(async (tx) => {
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
    await this.db.delete(postTbl).where(eq(postTbl.uri, uri))
  }

  async deletePostsByDid(did: string): Promise<number> {
    // FK ON DELETE CASCADE removes the matching post_boundary rows.
    const deleted = await this.db
      .delete(postTbl)
      .where(eq(postTbl.did, did))
      .returning({ uri: postTbl.uri })
    return deleted.length
  }

  async deletePostsByDidBoundary(
    did: string,
    boundary: string,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      // Only posts that actually held `boundary` are candidates for orphan
      // deletion - a pre-existing boundaryless post for this DID must not be
      // swept up by dropping an unrelated boundary.
      const candidates = await tx
        .select({ uri: postBoundaryTbl.uri })
        .from(postBoundaryTbl)
        .innerJoin(postTbl, eq(postTbl.uri, postBoundaryTbl.uri))
        .where(
          and(eq(postTbl.did, did), eq(postBoundaryTbl.boundary, boundary)),
        )
      if (candidates.length === 0) return 0
      const uris = candidates.map((c) => c.uri)
      // Drop this DID's membership in `boundary` from the index.
      await tx
        .delete(postBoundaryTbl)
        .where(
          and(
            eq(postBoundaryTbl.boundary, boundary),
            inArray(postBoundaryTbl.uri, uris),
          ),
        )
      // Delete only those candidates now left with no boundary rows at all.
      const deleted = await tx
        .delete(postTbl)
        .where(
          and(
            inArray(postTbl.uri, uris),
            sql`NOT EXISTS (SELECT 1 FROM post_boundary pb WHERE pb.uri = ${postTbl.uri})`,
          ),
        )
        .returning({ uri: postTbl.uri })
      return deleted.length
    })
  }

  async deletePostsByBoundary(boundary: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const scoped = await tx
        .select({ uri: postBoundaryTbl.uri })
        .from(postBoundaryTbl)
        .where(eq(postBoundaryTbl.boundary, boundary))
      if (scoped.length === 0) return 0
      const uris = [...new Set(scoped.map((r) => r.uri))]
      // FK ON DELETE CASCADE removes all boundary rows for these posts.
      await tx.delete(postTbl).where(inArray(postTbl.uri, uris))
      return uris.length
    })
  }

  async deleteCursor(did: string): Promise<number> {
    const deleted = await this.db
      .delete(syncCursorTbl)
      .where(eq(syncCursorTbl.did, did))
      .returning({ did: syncCursorTbl.did })
    return deleted.length
  }

  async getPost(uri: string): Promise<IndexedPost | null> {
    const rows = await this.db
      .select()
      .from(postTbl)
      .where(eq(postTbl.uri, uri))
      .limit(1)
    if (rows.length === 0) return null
    const boundaries = await this.db
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
    const rows = await this.db
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
    const rows = await this.db
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
    await this.db
      .insert(syncCursorTbl)
      .values({ did, seq, updatedAt })
      .onConflictDoUpdate({
        target: syncCursorTbl.did,
        set: { seq, updatedAt },
      })
  }

  async getCursor(did: string): Promise<number | null> {
    const rows = await this.db
      .select({ seq: syncCursorTbl.seq })
      .from(syncCursorTbl)
      .where(eq(syncCursorTbl.did, did))
      .limit(1)
    return rows.length === 0 ? null : rows[0].seq
  }

  async upsertEnrolledActor(input: EnrolledActorUpsert): Promise<void> {
    const boundariesJson = JSON.stringify(input.boundaries)
    await this.db
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
    const rows = await this.db
      .select()
      .from(enrolledActorTbl)
      .where(eq(enrolledActorTbl.did, did))
      .limit(1)
    if (rows.length === 0) return null
    return rowToEnrolledActor(rows[0])
  }

  async listEnrolledActors(): Promise<EnrolledActor[]> {
    const rows = await this.db.select().from(enrolledActorTbl)
    return rows.map(rowToEnrolledActor)
  }

  async deleteEnrolledActor(did: string): Promise<void> {
    await this.db.delete(enrolledActorTbl).where(eq(enrolledActorTbl.did, did))
  }

  async close(): Promise<void> {
    await this.db._client.end()
  }
}

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
