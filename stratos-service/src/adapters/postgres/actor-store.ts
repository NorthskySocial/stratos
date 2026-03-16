import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, gt, lt, and, asc, desc, inArray, isNull, sql } from 'drizzle-orm'
import { CID } from 'multiformats/cid'
import { AtUri } from '@atproto/syntax'
import * as crypto from '@atproto/crypto'

import {
  type StratosPgDb,
  type StratosPgDbOrTx,
  migrateStratosPgDb,
  pgSchema as pgActorSchema,
  pgStratosSigningKey,
  pgStratosRecord,
  pgStratosRepoBlock,
  pgStratosRepoRoot,
  pgStratosBacklink,
  pgStratosBlob,
  pgStratosRecordBlob,
  pgStratosSeq,
  countAll,
  getStratosBacklinks,
  BlockMap,
  CidSet,
  type Logger,
  type BlobStore,
  type BlobStoreCreator,
  type StatusAttr,
  type ListRecordsOpts,
  type RecordWithContent,
  type RecordWithMeta,
  type GetBacklinksOpts,
  type StratosRecordDescript,
  type CarBlock,
} from '@northskysocial/stratos-core'

import type {
  SequenceOperations,
  ActorReader,
  ActorTransactor,
  ActorStore,
} from '../../actor-store-types.js'

type PgBacklink = { uri: string; path: string; linkTo: string }

// ─── Record Reader ──────────────────────────────────────────────────────────

export class PgActorRecordReader {
  constructor(
    public readonly db: StratosPgDbOrTx,
    protected cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    protected logger?: Logger,
  ) {}

  async recordCount(): Promise<number> {
    const res = await this.db
      .select({ count: countAll })
      .from(pgStratosRecord)
      .limit(1)
    return Number(res[0]?.count ?? 0)
  }

  async listAll(): Promise<StratosRecordDescript[]> {
    const records: StratosRecordDescript[] = []
    let cursor: string | undefined = ''
    while (cursor !== undefined) {
      const res = await this.db
        .select({ uri: pgStratosRecord.uri, cid: pgStratosRecord.cid })
        .from(pgStratosRecord)
        .where(gt(pgStratosRecord.uri, cursor))
        .orderBy(asc(pgStratosRecord.uri))
        .limit(1000)
      for (const row of res) {
        const parsed = new AtUri(row.uri)
        records.push({
          uri: row.uri,
          path: `${parsed.collection}/${parsed.rkey}`,
          cid: CID.parse(row.cid),
        })
      }
      cursor = res.at(-1)?.uri
    }
    return records
  }

  async listCollections(): Promise<string[]> {
    const collections = await this.db
      .select({ collection: pgStratosRecord.collection })
      .from(pgStratosRecord)
      .groupBy(pgStratosRecord.collection)
    return collections.map((row) => row.collection)
  }

  async listRecordsForCollection(
    opts: ListRecordsOpts,
  ): Promise<RecordWithContent[]> {
    const {
      collection,
      limit,
      reverse,
      cursor,
      rkeyStart,
      rkeyEnd,
      includeSoftDeleted = false,
    } = opts

    const conditions = [eq(pgStratosRecord.collection, collection)]

    if (!includeSoftDeleted) {
      conditions.push(isNull(pgStratosRecord.takedownRef))
    }

    if (cursor !== undefined) {
      if (reverse) {
        conditions.push(gt(pgStratosRecord.rkey, cursor))
      } else {
        conditions.push(lt(pgStratosRecord.rkey, cursor))
      }
    } else {
      if (rkeyStart !== undefined) {
        conditions.push(gt(pgStratosRecord.rkey, rkeyStart))
      }
      if (rkeyEnd !== undefined) {
        conditions.push(lt(pgStratosRecord.rkey, rkeyEnd))
      }
    }

    const res = await this.db
      .select({
        uri: pgStratosRecord.uri,
        cid: pgStratosRecord.cid,
        content: pgStratosRepoBlock.content,
      })
      .from(pgStratosRecord)
      .innerJoin(
        pgStratosRepoBlock,
        eq(pgStratosRepoBlock.cid, pgStratosRecord.cid),
      )
      .where(and(...conditions))
      .orderBy(reverse ? asc(pgStratosRecord.rkey) : desc(pgStratosRecord.rkey))
      .limit(limit)

    return res.map((row) => ({
      uri: row.uri,
      cid: row.cid,
      value: this.cborToRecord(row.content),
    }))
  }

  async getRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted = false,
  ): Promise<RecordWithMeta | null> {
    const conditions = [eq(pgStratosRecord.uri, uri.toString())]

    if (!includeSoftDeleted) {
      conditions.push(isNull(pgStratosRecord.takedownRef))
    }
    if (cid) {
      conditions.push(eq(pgStratosRecord.cid, cid))
    }

    const res = await this.db
      .select({
        uri: pgStratosRecord.uri,
        cid: pgStratosRecord.cid,
        indexedAt: pgStratosRecord.indexedAt,
        takedownRef: pgStratosRecord.takedownRef,
        content: pgStratosRepoBlock.content,
      })
      .from(pgStratosRecord)
      .innerJoin(
        pgStratosRepoBlock,
        eq(pgStratosRepoBlock.cid, pgStratosRecord.cid),
      )
      .where(and(...conditions))
      .limit(1)

    const record = res[0]
    if (!record) return null
    return {
      uri: record.uri,
      cid: record.cid,
      value: this.cborToRecord(record.content),
      indexedAt: record.indexedAt,
      takedownRef: record.takedownRef ? record.takedownRef.toString() : null,
    }
  }

  async hasRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted = false,
  ): Promise<boolean> {
    const conditions = [eq(pgStratosRecord.uri, uri.toString())]

    if (!includeSoftDeleted) {
      conditions.push(isNull(pgStratosRecord.takedownRef))
    }
    if (cid) {
      conditions.push(eq(pgStratosRecord.cid, cid))
    }

    const res = await this.db
      .select({ uri: pgStratosRecord.uri })
      .from(pgStratosRecord)
      .where(and(...conditions))
      .limit(1)

    return res.length > 0
  }

  async getRecordTakedownStatus(uri: AtUri): Promise<StatusAttr | null> {
    const res = await this.db
      .select({ takedownRef: pgStratosRecord.takedownRef })
      .from(pgStratosRecord)
      .where(eq(pgStratosRecord.uri, uri.toString()))
      .limit(1)

    if (res.length === 0) return null
    return res[0].takedownRef
      ? { applied: true, ref: res[0].takedownRef }
      : { applied: false }
  }

  async getCurrentRecordCid(uri: AtUri): Promise<CID | null> {
    const res = await this.db
      .select({ cid: pgStratosRecord.cid })
      .from(pgStratosRecord)
      .where(eq(pgStratosRecord.uri, uri.toString()))
      .limit(1)

    return res.length > 0 ? CID.parse(res[0].cid) : null
  }

  async getRecordBacklinks(opts: GetBacklinksOpts) {
    const { collection, path, linkTo } = opts
    return await this.db
      .select({
        uri: pgStratosRecord.uri,
        cid: pgStratosRecord.cid,
        collection: pgStratosRecord.collection,
        rkey: pgStratosRecord.rkey,
        repoRev: pgStratosRecord.repoRev,
        indexedAt: pgStratosRecord.indexedAt,
        takedownRef: pgStratosRecord.takedownRef,
      })
      .from(pgStratosRecord)
      .innerJoin(
        pgStratosBacklink,
        eq(pgStratosBacklink.uri, pgStratosRecord.uri),
      )
      .where(
        and(
          eq(pgStratosBacklink.path, path),
          eq(pgStratosBacklink.linkTo, linkTo),
          eq(pgStratosRecord.collection, collection),
        ),
      )
  }

  async getBacklinkConflicts(
    uri: AtUri,
    record: Record<string, unknown>,
  ): Promise<AtUri[]> {
    const conflicts: AtUri[] = []

    for (const backlink of getStratosBacklinks(uri, record)) {
      const backlinks = await this.getRecordBacklinks({
        collection: uri.collection,
        path: backlink.path,
        linkTo: backlink.linkTo,
      })

      for (const { rkey } of backlinks) {
        conflicts.push(AtUri.make(uri.hostname, uri.collection, rkey))
      }
    }

    return conflicts
  }
}

// ─── Record Transactor ──────────────────────────────────────────────────────

export class PgActorRecordTransactor extends PgActorRecordReader {
  constructor(
    db: StratosPgDbOrTx,
    cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    logger?: Logger,
  ) {
    super(db, cborToRecord, logger)
  }

  async indexRecord(
    uri: AtUri,
    cid: CID,
    record: Record<string, unknown> | null,
    action: 'create' | 'update' = 'create',
    repoRev: string,
    timestamp?: string,
  ): Promise<void> {
    this.logger?.debug({ uri: uri.toString() }, 'indexing stratos record')

    const row = {
      uri: uri.toString(),
      cid: cid.toString(),
      collection: uri.collection,
      rkey: uri.rkey,
      repoRev: repoRev,
      indexedAt: timestamp || new Date().toISOString(),
    }

    if (!uri.hostname.startsWith('did:')) {
      throw new Error('Expected indexed URI to contain DID')
    } else if (row.collection.length < 1) {
      throw new Error('Expected indexed URI to contain a collection')
    } else if (row.rkey.length < 1) {
      throw new Error('Expected indexed URI to contain a record key')
    }

    await this.db
      .insert(pgStratosRecord)
      .values({
        ...row,
        takedownRef: null,
      })
      .onConflictDoUpdate({
        target: pgStratosRecord.uri,
        set: {
          cid: row.cid,
          repoRev: repoRev,
          indexedAt: row.indexedAt,
        },
      })

    if (record !== null) {
      const backlinks = getStratosBacklinks(uri, record)
      if (action === 'update') {
        await this.removeBacklinksByUri(uri)
      }
      await this.addBacklinks(backlinks)
    }

    this.logger?.info({ uri: uri.toString() }, 'indexed stratos record')
  }

  async deleteRecord(uri: AtUri): Promise<void> {
    this.logger?.debug(
      { uri: uri.toString() },
      'deleting indexed stratos record',
    )

    await Promise.all([
      this.db
        .delete(pgStratosRecord)
        .where(eq(pgStratosRecord.uri, uri.toString())),
      this.db
        .delete(pgStratosBacklink)
        .where(eq(pgStratosBacklink.uri, uri.toString())),
    ])

    this.logger?.info({ uri: uri.toString() }, 'deleted indexed stratos record')
  }

  async removeBacklinksByUri(uri: AtUri): Promise<void> {
    await this.db
      .delete(pgStratosBacklink)
      .where(eq(pgStratosBacklink.uri, uri.toString()))
  }

  async addBacklinks(backlinks: PgBacklink[]): Promise<void> {
    if (backlinks.length === 0) return
    await this.db
      .insert(pgStratosBacklink)
      .values(backlinks)
      .onConflictDoNothing()
  }

  async updateRecordTakedown(
    uri: AtUri,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void> {
    await this.db
      .update(pgStratosRecord)
      .set({ takedownRef: takedown.applied ? (takedown.ref ?? null) : null })
      .where(eq(pgStratosRecord.uri, uri.toString()))
  }
}

// ─── Repo Reader ────────────────────────────────────────────────────────────

type RevCursor = { rev: string; cid: string }

export class PgActorRepoReader {
  cache: BlockMap = new BlockMap()

  constructor(
    protected db: StratosPgDbOrTx,
    protected logger?: Logger,
  ) {}

  async hasRoot(): Promise<boolean> {
    const res = await this.db
      .select({ cid: pgStratosRepoRoot.cid })
      .from(pgStratosRepoRoot)
      .limit(1)
    return res.length > 0
  }

  async getRoot(): Promise<CID | null> {
    const root = await this.getRootDetailed()
    return root?.cid ?? null
  }

  async getRootDetailed(): Promise<{ cid: CID; rev: string } | null> {
    const res = await this.db
      .select({ cid: pgStratosRepoRoot.cid, rev: pgStratosRepoRoot.rev })
      .from(pgStratosRepoRoot)
      .limit(1)
    if (res.length === 0) return null
    return {
      cid: CID.parse(res[0].cid),
      rev: res[0].rev,
    }
  }

  async getBytes(cid: CID): Promise<Uint8Array | null> {
    const cached = this.cache.get(cid)
    if (cached) return cached
    const found = await this.db
      .select({ content: pgStratosRepoBlock.content })
      .from(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.cid, cid.toString()))
      .limit(1)
    if (found.length === 0) return null
    const content = new Uint8Array(found[0].content)
    this.cache.set(cid, content)
    return content
  }

  async has(cid: CID): Promise<boolean> {
    const got = await this.getBytes(cid)
    return !!got
  }

  async getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }> {
    const cached = this.cache.getMany(cids)
    if (cached.missing.length < 1) return cached
    const missing = new CidSet(cached.missing)
    const missingStr = cached.missing.map((c) => c.toString())
    const blocks = new BlockMap()

    for (let i = 0; i < missingStr.length; i += 500) {
      const batch = missingStr.slice(i, i + 500)
      const res = await this.db
        .select({
          cid: pgStratosRepoBlock.cid,
          content: pgStratosRepoBlock.content,
        })
        .from(pgStratosRepoBlock)
        .where(inArray(pgStratosRepoBlock.cid, batch))
      for (const row of res) {
        const cid = CID.parse(row.cid)
        blocks.set(cid, new Uint8Array(row.content))
        missing.delete(cid)
      }
    }

    this.cache.addMap(blocks)
    blocks.addMap(cached.blocks)
    return { blocks, missing: missing.toList() }
  }

  async *iterateCarBlocks(since?: string): AsyncIterable<CarBlock> {
    let cursor: RevCursor | undefined = undefined
    do {
      const res = await this.getBlockRange(since, cursor)
      for (const row of res) {
        yield {
          cid: CID.parse(row.cid),
          bytes: row.content,
        }
      }
      const lastRow = res.at(-1)
      if (lastRow && lastRow.repoRev) {
        cursor = { rev: lastRow.repoRev, cid: lastRow.cid }
      }
      if (res.length < 500) {
        break
      }
    } while (cursor)
  }

  async getBlockRange(
    since?: string,
    cursor?: RevCursor,
  ): Promise<{ cid: string; repoRev: string; content: Uint8Array }[]> {
    const conditions = []

    if (since) {
      conditions.push(gt(pgStratosRepoBlock.repoRev, since))
    }

    if (cursor) {
      const { rev, cid } = cursor
      conditions.push(
        sql`(${pgStratosRepoBlock.repoRev}, ${pgStratosRepoBlock.cid}) < (${rev}, ${cid})`,
      )
    }

    let query = this.db
      .select({
        cid: pgStratosRepoBlock.cid,
        repoRev: pgStratosRepoBlock.repoRev,
        content: pgStratosRepoBlock.content,
      })
      .from(pgStratosRepoBlock)
      .orderBy(desc(pgStratosRepoBlock.repoRev), desc(pgStratosRepoBlock.cid))
      .limit(500)

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query
    }

    const res = await query
    return res.map((row) => ({
      cid: row.cid,
      repoRev: row.repoRev,
      content: new Uint8Array(row.content),
    }))
  }

  async countBlocks(): Promise<number> {
    const res = await this.db
      .select({ count: countAll })
      .from(pgStratosRepoBlock)
    return Number(res[0]?.count ?? 0)
  }

  async listExistingBlocks(): Promise<CidSet> {
    const cids = new CidSet()
    let lastCid: string | undefined = ''
    while (lastCid !== undefined) {
      const res = await this.db
        .select({ cid: pgStratosRepoBlock.cid })
        .from(pgStratosRepoBlock)
        .where(gt(pgStratosRepoBlock.cid, lastCid))
        .orderBy(asc(pgStratosRepoBlock.cid))
        .limit(1000)
      for (const row of res) {
        cids.add(CID.parse(row.cid))
      }
      lastCid = res.at(-1)?.cid
    }
    return cids
  }
}

// ─── Repo Transactor ────────────────────────────────────────────────────────

export class PgActorRepoTransactor extends PgActorRepoReader {
  constructor(db: StratosPgDbOrTx, logger?: Logger) {
    super(db, logger)
  }

  async updateRoot(cid: CID, rev: string, did: string): Promise<void> {
    await this.db
      .insert(pgStratosRepoRoot)
      .values({
        did,
        cid: cid.toString(),
        rev,
        indexedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: pgStratosRepoRoot.did,
        set: {
          cid: cid.toString(),
          rev,
          indexedAt: new Date().toISOString(),
        },
      })
  }

  async putBlock(cid: CID, bytes: Uint8Array, rev: string): Promise<void> {
    await this.db
      .insert(pgStratosRepoBlock)
      .values({
        cid: cid.toString(),
        repoRev: rev,
        size: bytes.length,
        content: Buffer.from(bytes),
      })
      .onConflictDoNothing()

    this.cache.set(cid, bytes)
  }

  async putBlocks(blocks: BlockMap, rev: string): Promise<void> {
    const values: Array<{
      cid: string
      repoRev: string
      size: number
      content: Buffer
    }> = []

    for (const [cidStr, content] of blocks.entries()) {
      values.push({
        cid: cidStr,
        repoRev: rev,
        size: content.length,
        content: Buffer.from(content),
      })
      this.cache.set(CID.parse(cidStr), content)
    }

    if (values.length === 0) return

    for (let i = 0; i < values.length; i += 100) {
      const batch = values.slice(i, i + 100)
      await this.db
        .insert(pgStratosRepoBlock)
        .values(batch)
        .onConflictDoNothing()
    }
  }

  async deleteBlock(cid: CID): Promise<void> {
    await this.db
      .delete(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.cid, cid.toString()))
    this.cache.delete(cid)
  }

  async deleteBlocks(cids: CID[]): Promise<void> {
    if (cids.length === 0) return
    const cidStrs = cids.map((c) => c.toString())
    for (let i = 0; i < cidStrs.length; i += 500) {
      const batch = cidStrs.slice(i, i + 500)
      await this.db
        .delete(pgStratosRepoBlock)
        .where(inArray(pgStratosRepoBlock.cid, batch))
    }
    for (const cid of cids) {
      this.cache.delete(cid)
    }
  }

  async deleteBlocksForRev(rev: string): Promise<void> {
    await this.db
      .delete(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.repoRev, rev))
  }

  async clearCache(): Promise<void> {
    this.cache = new BlockMap()
  }
}

// ─── Blob Reader ────────────────────────────────────────────────────────────

export interface BlobMetadata {
  size: number
  mimeType?: string
}

export class PgActorBlobReader {
  constructor(
    protected db: StratosPgDbOrTx,
    protected blobstore: BlobStore,
    protected logger?: Logger,
  ) {}

  async getBlobMetadata(cid: CID): Promise<BlobMetadata | null> {
    const found = await this.db
      .select()
      .from(pgStratosBlob)
      .where(
        and(
          eq(pgStratosBlob.cid, cid.toString()),
          isNull(pgStratosBlob.takedownRef),
        ),
      )
      .limit(1)
    if (found.length === 0) return null
    return { size: found[0].size, mimeType: found[0].mimeType }
  }

  async getBlob(cid: CID): Promise<{
    size: number
    mimeType?: string
    stream: AsyncIterable<Uint8Array>
  } | null> {
    const metadata = await this.getBlobMetadata(cid)
    if (!metadata) return null
    try {
      const stream = await this.blobstore.getStream(cid)
      return { ...metadata, stream }
    } catch {
      return null
    }
  }

  async listBlobs(opts: {
    since?: string
    cursor?: string
    limit: number
  }): Promise<string[]> {
    const { since, cursor, limit } = opts

    if (since) {
      const res = await this.db
        .selectDistinct({ blobCid: pgStratosRecordBlob.blobCid })
        .from(pgStratosRecordBlob)
        .innerJoin(
          pgStratosRecord,
          eq(pgStratosRecord.uri, pgStratosRecordBlob.recordUri),
        )
        .where(
          and(
            gt(pgStratosRecord.repoRev, since),
            ...(cursor ? [gt(pgStratosRecordBlob.blobCid, cursor)] : []),
          ),
        )
        .orderBy(asc(pgStratosRecordBlob.blobCid))
        .limit(limit)
      return res.map((row) => row.blobCid)
    }

    const conditions = []
    if (cursor) {
      conditions.push(gt(pgStratosRecordBlob.blobCid, cursor))
    }

    const res = await this.db
      .selectDistinct({ blobCid: pgStratosRecordBlob.blobCid })
      .from(pgStratosRecordBlob)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(pgStratosRecordBlob.blobCid))
      .limit(limit)
    return res.map((row) => row.blobCid)
  }

  async getBlobTakedownStatus(cid: CID): Promise<StatusAttr | null> {
    const res = await this.db
      .select({ takedownRef: pgStratosBlob.takedownRef })
      .from(pgStratosBlob)
      .where(eq(pgStratosBlob.cid, cid.toString()))
      .limit(1)
    if (res.length === 0) return null
    return res[0].takedownRef
      ? { applied: true, ref: res[0].takedownRef }
      : { applied: false }
  }

  async getRecordsForBlob(cid: CID): Promise<string[]> {
    const res = await this.db
      .select()
      .from(pgStratosRecordBlob)
      .where(eq(pgStratosRecordBlob.blobCid, cid.toString()))
    return res.map((row) => row.recordUri)
  }

  async hasBlob(cid: CID): Promise<boolean> {
    const res = await this.db
      .select({ cid: pgStratosBlob.cid })
      .from(pgStratosBlob)
      .where(eq(pgStratosBlob.cid, cid.toString()))
      .limit(1)
    return res.length > 0
  }
}

// ─── Blob Transactor ────────────────────────────────────────────────────────

export class PgActorBlobTransactor extends PgActorBlobReader {
  constructor(db: StratosPgDbOrTx, blobstore: BlobStore, logger?: Logger) {
    super(db, blobstore, logger)
  }

  async trackBlob(blob: {
    cid: CID
    mimeType: string
    size: number
    tempKey?: string | null
    width?: number | null
    height?: number | null
  }): Promise<void> {
    await this.db
      .insert(pgStratosBlob)
      .values({
        cid: blob.cid.toString(),
        mimeType: blob.mimeType,
        size: blob.size,
        tempKey: blob.tempKey ?? null,
        width: blob.width ?? null,
        height: blob.height ?? null,
        createdAt: new Date().toISOString(),
        takedownRef: null,
      })
      .onConflictDoNothing()
  }

  async associateBlobWithRecord(
    blobCid: CID,
    recordUri: string,
  ): Promise<void> {
    await this.db
      .insert(pgStratosRecordBlob)
      .values({ blobCid: blobCid.toString(), recordUri })
      .onConflictDoNothing()
  }

  async processBlobs(
    recordUri: string,
    blobs: Array<{ cid: CID; mimeType: string; tempKey?: string | null }>,
  ): Promise<void> {
    for (const blob of blobs) {
      if (blob.tempKey) {
        await this.blobstore.makePermanent(blob.tempKey, blob.cid)
      }
      await this.trackBlob({
        cid: blob.cid,
        mimeType: blob.mimeType,
        size: 0,
        tempKey: null,
      })
      await this.associateBlobWithRecord(blob.cid, recordUri)
    }
  }

  async removeRecordBlobAssociations(recordUri: string): Promise<void> {
    await this.db
      .delete(pgStratosRecordBlob)
      .where(eq(pgStratosRecordBlob.recordUri, recordUri))
  }

  async updateBlobTakedown(
    cid: CID,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void> {
    await this.db
      .update(pgStratosBlob)
      .set({ takedownRef: takedown.applied ? (takedown.ref ?? null) : null })
      .where(eq(pgStratosBlob.cid, cid.toString()))
  }

  async deleteOrphanBlobs(): Promise<CID[]> {
    const allBlobs = await this.db
      .select({ cid: pgStratosBlob.cid })
      .from(pgStratosBlob)

    const deletedCids: CID[] = []
    for (const { cid } of allBlobs) {
      const associations = await this.db
        .select({ blobCid: pgStratosRecordBlob.blobCid })
        .from(pgStratosRecordBlob)
        .where(eq(pgStratosRecordBlob.blobCid, cid))
        .limit(1)

      if (associations.length === 0) {
        const cidObj = CID.parse(cid)
        await this.blobstore.delete(cidObj)
        await this.db.delete(pgStratosBlob).where(eq(pgStratosBlob.cid, cid))
        deletedCids.push(cidObj)
      }
    }

    return deletedCids
  }
}

// ─── Sequence Operations ────────────────────────────────────────────────────

export class PgSequenceOps implements SequenceOperations {
  constructor(private db: StratosPgDbOrTx) {}

  async getLatestSeq(): Promise<number> {
    const rows = await this.db
      .select({ seq: pgStratosSeq.seq })
      .from(pgStratosSeq)
      .orderBy(desc(pgStratosSeq.seq))
      .limit(1)
    return rows[0]?.seq ?? 0
  }

  async getOldestSeq(): Promise<number> {
    const rows = await this.db
      .select({ seq: pgStratosSeq.seq })
      .from(pgStratosSeq)
      .orderBy(asc(pgStratosSeq.seq))
      .limit(1)
    return rows[0]?.seq ?? 0
  }

  async getEventsSince(
    cursor: number,
    limit = 100,
  ): Promise<
    Array<{
      seq: number
      did: string
      eventType: string
      event: Buffer
      invalidated: number
      sequencedAt: string
    }>
  > {
    const rows = await this.db
      .select()
      .from(pgStratosSeq)
      .where(gt(pgStratosSeq.seq, cursor))
      .orderBy(asc(pgStratosSeq.seq))
      .limit(limit)
    return rows.map((row) => ({
      seq: row.seq,
      did: row.did,
      eventType: row.eventType,
      event: Buffer.from(row.event as Uint8Array),
      invalidated: row.invalidated,
      sequencedAt: row.sequencedAt,
    }))
  }

  async appendEvent(event: {
    did: string
    eventType: string
    event: Buffer
    invalidated: number
    sequencedAt: string
  }): Promise<void> {
    await this.db.insert(pgStratosSeq).values(event)
  }
}

// ─── PostgresActorStore ─────────────────────────────────────────────────────

function actorSchemaName(didHash: string): string {
  return `actor_${didHash.slice(0, 12)}`
}

export interface PostgresActorStoreConfig {
  connectionString: string
  blobstore: BlobStoreCreator
  cborToRecord: (content: Uint8Array) => Record<string, unknown>
  logger?: Logger
}

export class PostgresActorStore implements ActorStore {
  private readonly connectionString: string
  private readonly blobstore: BlobStoreCreator
  private readonly cborToRecord: (
    content: Uint8Array,
  ) => Record<string, unknown>
  private readonly logger?: Logger
  private readonly adminClient: ReturnType<typeof postgres>
  private readonly adminDb: StratosPgDb
  private readonly actorClient: ReturnType<typeof postgres>
  private readonly actorDb: StratosPgDb

  constructor(config: PostgresActorStoreConfig) {
    this.connectionString = config.connectionString
    this.blobstore = config.blobstore
    this.cborToRecord = config.cborToRecord
    this.logger = config.logger
    this.adminClient = postgres(this.connectionString, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    })
    this.adminDb = drizzle({ client: this.adminClient })
    // Shared pool for all per-actor operations; search_path set per transaction via SET LOCAL
    this.actorClient = postgres(this.connectionString, {
      max: 100,
      idle_timeout: 20,
      connect_timeout: 10,
    })
    this.actorDb = drizzle({ client: this.actorClient, schema: pgActorSchema })
  }

  async close(): Promise<void> {
    await this.adminClient.end()
    await this.actorClient.end()
  }

  private async getSchemaName(did: string): Promise<string> {
    const didHash = await crypto.sha256Hex(did)
    return actorSchemaName(didHash)
  }

  async exists(did: string): Promise<boolean> {
    const schemaName = await this.getSchemaName(did)
    const rows = await this.adminDb.execute(
      sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schemaName} LIMIT 1`,
    )
    return rows.length > 0
  }

  async create(did: string): Promise<void> {
    const schemaName = await this.getSchemaName(did)
    const client = postgres(this.connectionString, {
      max: 2,
      idle_timeout: 10,
      connect_timeout: 10,
      connection: { search_path: schemaName },
    })
    const actorDb = drizzle({ client, schema: pgActorSchema })
    try {
      await migrateStratosPgDb(actorDb, schemaName)
    } finally {
      await client.end()
    }
  }

  async destroy(did: string): Promise<void> {
    const schemaName = await this.getSchemaName(did)
    await this.adminDb.execute(
      sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
    )
  }

  async read<T>(
    did: string,
    fn: (store: ActorReader) => T | PromiseLike<T>,
  ): Promise<T> {
    const schemaName = await this.getSchemaName(did)
    const blobStore = this.blobstore(did)

    return this.actorDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`))
      const txDb = tx as unknown as StratosPgDb
      const store: ActorReader = {
        did,
        record: new PgActorRecordReader(txDb, this.cborToRecord, this.logger),
        repo: new PgActorRepoReader(txDb, this.logger),
        blob: new PgActorBlobReader(txDb, blobStore, this.logger),
        sequence: new PgSequenceOps(txDb),
      }
      return fn(store)
    })
  }

  async transact<T>(
    did: string,
    fn: (store: ActorTransactor) => T | PromiseLike<T>,
  ): Promise<T> {
    const schemaName = await this.getSchemaName(did)
    const blobStore = this.blobstore(did)

    return this.actorDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`))
      const txDb = tx as unknown as StratosPgDb
      const store: ActorTransactor = {
        did,
        record: new PgActorRecordTransactor(
          txDb,
          this.cborToRecord,
          this.logger,
        ),
        repo: new PgActorRepoTransactor(txDb, this.logger),
        blob: new PgActorBlobTransactor(txDb, blobStore, this.logger),
        sequence: new PgSequenceOps(txDb),
      }
      return fn(store)
    })
  }

  getBlobStore(did: string): BlobStore {
    return this.blobstore(did)
  }

  async createSigningKey(did: string): Promise<crypto.P256Keypair> {
    const schemaName = await this.getSchemaName(did)
    return this.actorDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`))
      const keypair = await crypto.P256Keypair.create({ exportable: true })
      const exported = await (keypair as crypto.ExportableKeypair).export()
      const txDb = tx as unknown as StratosPgDb
      await txDb
        .insert(pgStratosSigningKey)
        .values({ did, key: Buffer.from(exported) })
        .onConflictDoUpdate({
          target: pgStratosSigningKey.did,
          set: { key: Buffer.from(exported) },
        })
      return keypair
    })
  }

  async loadSigningKey(did: string): Promise<crypto.P256Keypair | null> {
    const schemaName = await this.getSchemaName(did)
    return this.actorDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`))
      const txDb = tx as unknown as StratosPgDb
      const rows = await txDb
        .select({ key: pgStratosSigningKey.key })
        .from(pgStratosSigningKey)
        .where(eq(pgStratosSigningKey.did, did))
        .limit(1)
      if (rows.length === 0) return null
      return crypto.P256Keypair.import(new Uint8Array(rows[0].key), {
        exportable: true,
      })
    })
  }

  async deleteSigningKey(did: string): Promise<void> {
    const schemaName = await this.getSchemaName(did)
    await this.actorDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`))
      const txDb = tx as unknown as StratosPgDb
      await txDb
        .delete(pgStratosSigningKey)
        .where(eq(pgStratosSigningKey.did, did))
    })
  }
}
