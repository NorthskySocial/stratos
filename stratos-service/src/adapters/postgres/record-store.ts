import { CID } from 'multiformats/cid'
import { AtUri } from '@atproto/syntax'
import * as syntax from '@atproto/syntax'
import { eq, and, gt, lt, asc, desc, isNull, sql } from 'drizzle-orm'
import type {
  RecordStoreReader,
  RecordStoreWriter,
  RecordDescript,
  RecordValue,
  ListRecordsOptions,
  GetRecordOptions,
} from '@northskysocial/stratos-core'
import {
  type StratosPgDb,
  type StratosPgDbOrTx,
  pgStratosRecord,
  pgStratosRepoBlock,
  pgStratosBacklink,
} from '@northskysocial/stratos-core'

export class PgRecordStoreReader implements RecordStoreReader {
  constructor(
    protected db: StratosPgDb | StratosPgDbOrTx,
    protected cborToRecord: (content: Uint8Array) => Record<string, unknown>,
  ) {}

  async recordCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(pgStratosRecord)
    return Number(rows[0]?.count ?? 0)
  }

  async listAll(): Promise<RecordDescript[]> {
    const records: RecordDescript[] = []
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
          cid: CID.parse(row.cid),
          collection: parsed.collection,
          rkey: parsed.rkey,
        })
      }
      cursor = res.at(-1)?.uri
    }
    return records
  }

  async listRecords(options: ListRecordsOptions): Promise<RecordValue[]> {
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
  }

  async getRecord(options: GetRecordOptions): Promise<RecordValue | null> {
    const uri = new AtUri(options.uri)
    const conditions = [eq(pgStratosRecord.uri, uri.toString())]

    if (!options.includeSoftDeleted) {
      conditions.push(isNull(pgStratosRecord.takedownRef))
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
      takedownRef: record.takedownRef,
    }
  }

  async hasRecord(uri: string): Promise<boolean> {
    const rows = await this.db
      .select({ uri: pgStratosRecord.uri })
      .from(pgStratosRecord)
      .where(eq(pgStratosRecord.uri, uri))
      .limit(1)

    return rows.length > 0
  }

  async getRecordContent(cid: CID): Promise<Uint8Array | null> {
    const rows = await this.db
      .select({ content: pgStratosRepoBlock.content })
      .from(pgStratosRepoBlock)
      .where(eq(pgStratosRepoBlock.cid, cid.toString()))
      .limit(1)

    const content = rows[0]?.content
    return content ? content : null
  }
}

function getBacklinks(
  uri: AtUri,
  record: Record<string, unknown>,
): { uri: string; path: string; linkTo: string }[] {
  const backlinks: { uri: string; path: string; linkTo: string }[] = []

  const subject = record?.['subject']
  if (typeof subject === 'string') {
    try {
      syntax.ensureValidDid(subject)
      backlinks.push({ uri: uri.toString(), path: 'subject', linkTo: subject })
    } catch {
      try {
        syntax.ensureValidAtUri(subject)
        backlinks.push({
          uri: uri.toString(),
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
      syntax.ensureValidAtUri(subjectUri)
      backlinks.push({
        uri: uri.toString(),
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
  async putRecord(record: {
    uri: string
    cid: CID
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }): Promise<void> {
    const uri = new AtUri(record.uri)

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

  async deleteRecord(uri: string): Promise<void> {
    await Promise.all([
      this.db.delete(pgStratosRecord).where(eq(pgStratosRecord.uri, uri)),
      this.db.delete(pgStratosBacklink).where(eq(pgStratosBacklink.uri, uri)),
    ])
  }

  async takedownRecord(uri: string, takedownRef: string): Promise<void> {
    await this.db
      .update(pgStratosRecord)
      .set({ takedownRef })
      .where(eq(pgStratosRecord.uri, uri))
  }

  async restoreRecord(uri: string): Promise<void> {
    await this.db
      .update(pgStratosRecord)
      .set({ takedownRef: null })
      .where(eq(pgStratosRecord.uri, uri))
  }
}
