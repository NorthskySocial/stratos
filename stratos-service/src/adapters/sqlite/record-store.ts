/**
 * SQLite Record Store Adapter
 *
 * Implements RecordStoreReader/Writer by wrapping the existing
 * StratosRecordReader/Transactor from stratos-core.
 */
import { CID } from 'multiformats/cid'
import { AtUri } from '@atproto/syntax'
import { eq, and, isNull } from 'drizzle-orm'
import type {
  RecordStoreReader,
  RecordStoreWriter,
  RecordDescript,
  RecordValue,
  ListRecordsOptions,
  GetRecordOptions,
} from '@anthropic/stratos-core'
import {
  StratosDb,
  stratosRecord,
  stratosRepoBlock,
  StratosRecordReader,
  StratosRecordTransactor,
} from '@anthropic/stratos-core'

/**
 * SQLite implementation of RecordStoreReader
 */
export class SqliteRecordStoreReader implements RecordStoreReader {
  protected reader: StratosRecordReader

  constructor(
    protected db: StratosDb,
    protected cborToRecord: (content: Uint8Array) => Record<string, unknown>,
  ) {
    this.reader = new StratosRecordReader(db, cborToRecord)
  }

  async recordCount(): Promise<number> {
    return this.reader.recordCount()
  }

  async listAll(): Promise<RecordDescript[]> {
    const records = await this.reader.listAll()
    return records.map((r) => ({
      uri: r.uri,
      cid: r.cid,
      collection: new AtUri(r.uri).collection,
      rkey: new AtUri(r.uri).rkey,
    }))
  }

  async listRecords(options: ListRecordsOptions): Promise<RecordValue[]> {
    const records = await this.reader.listRecordsForCollection({
      collection: options.collection,
      limit: options.limit,
      reverse: options.reverse ?? false,
      cursor: options.cursor,
      rkeyStart: options.rkeyStart,
      rkeyEnd: options.rkeyEnd,
      includeSoftDeleted: options.includeSoftDeleted,
    })

    return records.map((r) => ({
      uri: r.uri,
      cid: r.cid,
      value: r.value,
      indexedAt: new Date().toISOString(), // Not available in current impl
      takedownRef: null,
    }))
  }

  async getRecord(options: GetRecordOptions): Promise<RecordValue | null> {
    const uri = new AtUri(options.uri)
    const record = await this.reader.getRecord(
      uri,
      null,
      options.includeSoftDeleted,
    )
    if (!record) return null

    return {
      uri: record.uri,
      cid: record.cid,
      value: record.value,
      indexedAt: record.indexedAt,
      takedownRef: record.takedownRef,
    }
  }

  async hasRecord(uri: string): Promise<boolean> {
    const atUri = new AtUri(uri)
    const record = await this.reader.getRecord(atUri, null, true)
    return record !== null
  }

  async getRecordContent(cid: CID): Promise<Uint8Array | null> {
    const rows = await this.db
      .select({ content: stratosRepoBlock.content })
      .from(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))
      .limit(1)

    return rows[0]?.content ?? null
  }
}

/**
 * SQLite implementation of RecordStoreWriter
 */
export class SqliteRecordStoreWriter
  extends SqliteRecordStoreReader
  implements RecordStoreWriter
{
  protected transactor: StratosRecordTransactor

  constructor(
    db: StratosDb,
    cborToRecord: (content: Uint8Array) => Record<string, unknown>,
  ) {
    super(db, cborToRecord)
    this.transactor = new StratosRecordTransactor(db, cborToRecord)
  }

  async putRecord(record: {
    uri: string
    cid: CID
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }): Promise<void> {
    const uri = new AtUri(record.uri)

    // First store the block content
    await this.db
      .insert(stratosRepoBlock)
      .values({
        cid: record.cid.toString(),
        repoRev: '', // Will be set by indexRecord
        size: record.content.length,
        content: Buffer.from(record.content),
      })
      .onConflictDoNothing()

    // Then index the record
    await this.transactor.indexRecord(
      uri,
      record.cid,
      record.value,
      'create',
      '', // repo rev
      record.indexedAt,
    )
  }

  async deleteRecord(uri: string): Promise<void> {
    const atUri = new AtUri(uri)
    await this.transactor.deleteRecord(atUri)
  }

  async takedownRecord(uri: string, takedownRef: string): Promise<void> {
    const atUri = new AtUri(uri)
    await this.transactor.updateRecordTakedown(atUri, {
      applied: true,
      ref: takedownRef,
    })
  }

  async restoreRecord(uri: string): Promise<void> {
    const atUri = new AtUri(uri)
    await this.transactor.updateRecordTakedown(atUri, { applied: false })
  }
}
