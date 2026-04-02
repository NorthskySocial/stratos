/**
 * SQLite Record Store Adapter
 *
 * Implements RecordStoreReader/Writer by wrapping the existing
 * StratosRecordReader/Transactor from stratos-core.
 */
import { eq } from 'drizzle-orm'
import { CID } from '@atproto/lex-data'
import type {
  GetRecordOptions,
  ListRecordsOptions,
  RecordDescript,
  RecordStoreReader,
  RecordStoreWriter,
  RecordValue,
} from '@northskysocial/stratos-core'
import {
  type StratosDb,
  StratosRecordReader,
  StratosRecordTransactor,
  stratosRepoBlock,
} from '@northskysocial/stratos-core'
import { AtUri as AtUriSyntax } from '@atproto/syntax'

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

  /**
   * Get the total number of records in the store.
   * @returns The total number of records.
   */
  async recordCount(): Promise<number> {
    return this.reader.recordCount()
  }

  /**
   * List all records in the store.
   * @returns An array of record descriptions.
   */
  async listAll(): Promise<RecordDescript[]> {
    const records = await this.reader.listAll()
    return records.map((r) => ({
      uri: r.uri,
      cid: r.cid,
      collection: new AtUriSyntax(r.uri).collection,
      rkey: new AtUriSyntax(r.uri).rkey,
    }))
  }

  /**
   * List records in the store based on provided options.
   * @param options - Options for listing records.
   * @returns An array of record values.
   */
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

  /**
   * Get a record from the store by URI.
   * @param options - Options for getting a record.
   * @returns The record value or null if not found.
   */
  async getRecord(options: GetRecordOptions): Promise<RecordValue | null> {
    const uri = new AtUriSyntax(options.uri)
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

  /**
   * Check if a record exists in the store by URI.
   * @param uri - The URI of the record.
   * @returns True if the record exists, false otherwise.
   */
  async hasRecord(uri: string): Promise<boolean> {
    const atUri = new AtUriSyntax(uri)
    const record = await this.reader.getRecord(atUri, null, true)
    return record !== null
  }

  /**
   * Get the content of a record by CID.
   * @param cid - The CID of the record content.
   * @returns The record content as Uint8Array or null if not found.
   */
  async getRecordContent(cid: CID): Promise<Uint8Array | null> {
    const rows = await this.db
      .select({ content: stratosRepoBlock.content })
      .from(stratosRepoBlock)
      .where(eq(stratosRepoBlock.cid, cid.toString()))
      .limit(1)

    const content = rows[0]?.content
    return content ? (content as Uint8Array) : null
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

  /**
   * Put a record into the store.
   *
   * @param record - The record to be stored.
   */
  async putRecord(record: {
    uri: string
    cid: CID
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }): Promise<void> {
    const uri = new AtUriSyntax(record.uri)

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

  /**
   * Delete a record from the store.
   *
   * @param uri - The URI of the record to be deleted.
   */
  async deleteRecord(uri: string): Promise<void> {
    const atUri = new AtUriSyntax(uri)
    await this.transactor.deleteRecord(atUri)
  }

  /**
   * Update a record in the store.
   * @param uri - The URI of the record to be updated.
   * @param takedownRef - The takedown reference for the update.
   */
  async takedownRecord(uri: string, takedownRef: string): Promise<void> {
    const atUri = new AtUriSyntax(uri)
    await this.transactor.updateRecordTakedown(atUri, {
      applied: true,
      ref: takedownRef,
    })
  }

  /**
   * Restore a record in the store.
   * @param uri - The URI of the record to be restored.
   */
  async restoreRecord(uri: string): Promise<void> {
    const atUri = new AtUriSyntax(uri)
    await this.transactor.updateRecordTakedown(atUri, { applied: false })
  }
}
