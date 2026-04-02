import { CID } from '@atproto/lex-data'
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type {
  AtUri,
  GetRecordOptions,
  ListRecordsOptions,
  RecordDescript,
  RecordStoreReader,
  RecordStoreWriter,
  RecordValue,
} from '@northskysocial/stratos-core'
import {
  pgStratosBacklink,
  pgStratosRecord,
  pgStratosRepoBlock,
  type StratosPgDb,
  type StratosPgDbOrTx,
} from '@northskysocial/stratos-core'
import {
  AtUri as AtUriSyntax,
  ensureValidAtUri,
  ensureValidDid,
} from '@atproto/syntax'

export class PgRecordStoreReader implements RecordStoreReader {
  constructor(
    protected db: StratosPgDb | StratosPgDbOrTx,
    protected cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    protected schemaName?: string,
  ) {}

  /**
   * Get the record count
   * @returns The number of records in the database
   */
  async recordCount(): Promise<number> {
    return this.withDb(async (db) => {
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(pgStratosRecord)
      return Number(rows[0]?.count ?? 0)
    })
  }

  /**
   * List all records
   * @returns List of all records
   */
  async listAll(): Promise<RecordDescript[]> {
    return this.withDb(async (db) => {
      const records: RecordDescript[] = []
      let cursor: string | undefined = ''
      while (cursor !== undefined) {
        const res = await db
          .select({ uri: pgStratosRecord.uri, cid: pgStratosRecord.cid })
          .from(pgStratosRecord)
          .where(gt(pgStratosRecord.uri, cursor))
          .orderBy(asc(pgStratosRecord.uri))
          .limit(1000)
        for (const row of res) {
          const parsed = new AtUriSyntax(row.uri)
          records.push({
            uri: row.uri,
            cid: CID.parse(row.cid),
            collection: parsed.collection,
            rkey: parsed.rkey,
          })
        }
        cursor = res.at(-1)?.uri
      }
      return records
    })
  }

  /**
   * List records with specified options
   * @param options - List records options
   * @returns List of records matching the options
   */
  async listRecords(options: ListRecordsOptions): Promise<RecordValue[]> {
    return this.withDb(async (db) => {
      const conditions = [eq(pgStratosRecord.collection, options.collection)]

      if (!options.includeSoftDeleted) {
        conditions.push(isNull(pgStratosRecord.takedownRef))
      }

      if (options.cursor !== undefined) {
        if (options.reverse) {
          conditions.push(gt(pgStratosRecord.rkey, options.cursor))
        } else {
          conditions.push(lt(pgStratosRecord.rkey, options.cursor))
        }
      } else {
        if (options.rkeyStart !== undefined) {
          conditions.push(gt(pgStratosRecord.rkey, options.rkeyStart))
        }
        if (options.rkeyEnd !== undefined) {
          conditions.push(lt(pgStratosRecord.rkey, options.rkeyEnd))
        }
      }

      const res = await db
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
        .orderBy(
          options.reverse
            ? asc(pgStratosRecord.rkey)
            : desc(pgStratosRecord.rkey),
        )
        .limit(options.limit ?? 50)

      return res.map((row) => ({
        uri: row.uri,
        cid: row.cid,
        value: this.cborToRecord(row.content),
        indexedAt: new Date().toISOString(),
        takedownRef: null,
      }))
    })
  }

  /**
   * Get a record by URI
   * @param options - Get record options
   * @returns Record value or null if not found
   */
  async getRecord(options: GetRecordOptions): Promise<RecordValue | null> {
    return this.withDb(async (db) => {
      const uri = new AtUriSyntax(options.uri)
      const conditions = [eq(pgStratosRecord.uri, uri.toString())]

      if (!options.includeSoftDeleted) {
        conditions.push(isNull(pgStratosRecord.takedownRef))
      }

      const res = await db
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
        takedownRef: record.takedownRef,
      }
    })
  }

  /**
   * Check if a record exists
   * @param uri - URI of the record
   * @returns True if record exists, false otherwise
   */
  async hasRecord(uri: string): Promise<boolean> {
    return this.withDb(async (db) => {
      const rows = await db
        .select({ uri: pgStratosRecord.uri })
        .from(pgStratosRecord)
        .where(eq(pgStratosRecord.uri, uri.toString()))
        .limit(1)

      return rows.length > 0
    })
  }

  /**
   * Get record content by CID
   * @param cid - CID of the record content
   * @returns Record content as Uint8Array or null if not found
   */
  async getRecordContent(cid: CID): Promise<Uint8Array | null> {
    return this.withDb(async (db) => {
      const rows = await db
        .select({ content: pgStratosRepoBlock.content })
        .from(pgStratosRepoBlock)
        .where(eq(pgStratosRepoBlock.cid, cid.toString()))
        .limit(1)

      const content = rows[0]?.content
      return content || null
    })
  }

  /**
   * With database transaction
   * @param fn - Function to execute in transaction
   * @returns Result of function execution
   * @protected
   */
  protected async withDb<T>(fn: (db: StratosPgDb) => Promise<T>): Promise<T> {
    if (!this.schemaName) {
      return fn(this.db as StratosPgDb)
    }
    return (this.db as StratosPgDb).transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${this.schemaName}"`))
      return fn(tx as unknown as StratosPgDb)
    })
  }
}

/**
 * Get backlinks for a record
 * @param uri - URI of the record
 * @param record - Record object
 * @returns Array of backlinks
 */
function getBacklinks(
  uri: string | AtUri,
  record: Record<string, unknown>,
): { uri: string; path: string; linkTo: string }[] {
  const backlinks: { uri: string; path: string; linkTo: string }[] = []
  const uriStr = uri.toString()

  const subject = record?.['subject']
  if (typeof subject === 'string') {
    try {
      ensureValidDid(subject)
      backlinks.push({ uri: uriStr, path: 'subject', linkTo: subject })
    } catch {
      try {
        ensureValidAtUri(subject)
        backlinks.push({
          uri: uriStr,
          path: 'subject',
          linkTo: subject,
        })
      } catch {
        // Not a valid reference
      }
    }
  } else if (
    subject &&
    typeof (subject as Record<string, unknown>)['uri'] === 'string'
  ) {
    try {
      const subjectUri = (subject as Record<string, unknown>)['uri'] as string
      ensureValidAtUri(subjectUri)
      backlinks.push({
        uri: uriStr,
        path: 'subject.uri',
        linkTo: subjectUri,
      })
    } catch {
      // Not a valid AT-URI
    }
  }

  return backlinks
}

export class PgRecordStoreWriter
  extends PgRecordStoreReader
  implements RecordStoreWriter
{
  /**
   * Put the record into the store
   * @param record - Record to put into the store
   */
  async putRecord(record: {
    uri: string
    cid: CID
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }): Promise<void> {
    const uri = new AtUriSyntax(record.uri)

    await this.db
      .insert(pgStratosRepoBlock)
      .values({
        cid: record.cid.toString(),
        repoRev: '',
        size: record.content.length,
        content: Buffer.from(record.content),
      })
      .onConflictDoNothing()

    const row = {
      uri: uri.toString(),
      cid: record.cid.toString(),
      collection: uri.collection,
      rkey: uri.rkey,
      repoRev: '',
      indexedAt: record.indexedAt || new Date().toISOString(),
      takedownRef: null,
    }

    await this.db
      .insert(pgStratosRecord)
      .values(row)
      .onConflictDoUpdate({
        target: pgStratosRecord.uri,
        set: {
          cid: row.cid,
          repoRev: row.repoRev,
          indexedAt: row.indexedAt,
        },
      })

    if (record.value) {
      const backlinks = getBacklinks(uri, record.value)
      if (backlinks.length > 0) {
        await this.db
          .insert(pgStratosBacklink)
          .values(backlinks)
          .onConflictDoNothing()
      }
    }
  }

  /**
   * Delete a record and its backlinks
   * @param uri - URI of the record to delete
   */
  async deleteRecord(uri: string): Promise<void> {
    await Promise.all([
      this.db
        .delete(pgStratosRecord)
        .where(eq(pgStratosRecord.uri, uri.toString())),
      this.db
        .delete(pgStratosBacklink)
        .where(eq(pgStratosBacklink.uri, uri.toString())),
    ])
  }

  /**
   * Take down a record
   * @param uri - URI of the record to takedown
   * @param takedownRef - Reference to the takedown
   */
  async takedownRecord(uri: string, takedownRef: string): Promise<void> {
    await this.db
      .update(pgStratosRecord)
      .set({ takedownRef })
      .where(eq(pgStratosRecord.uri, uri.toString()))
  }

  /**
   * Restore a record
   * @param uri - URI of the record to restore
   */
  async restoreRecord(uri: string): Promise<void> {
    await this.db
      .update(pgStratosRecord)
      .set({ takedownRef: null })
      .where(eq(pgStratosRecord.uri, uri.toString()))
  }
}
