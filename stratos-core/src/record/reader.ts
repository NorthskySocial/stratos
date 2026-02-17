import { CID } from 'multiformats/cid'
import { AtUri } from '@atproto/syntax'
import * as syntax from '@atproto/syntax'
import { eq, and, gt, lt, asc, desc, isNull } from 'drizzle-orm'
import {
  StratosDbOrTx,
  StratosBacklink,
  countAll,
  stratosRecord,
  stratosRepoBlock,
  stratosBacklink,
} from '../db/index.js'
import { StatusAttr, Logger } from '../types.js'

/**
 * Descriptor for a stratos record
 */
export interface StratosRecordDescript {
  uri: string
  path: string
  cid: CID
}

/**
 * Options for listing records in a collection
 */
export interface ListRecordsOpts {
  collection: string
  limit: number
  reverse: boolean
  cursor?: string
  rkeyStart?: string
  rkeyEnd?: string
  includeSoftDeleted?: boolean
}

/**
 * Options for getting record backlinks
 */
export interface GetBacklinksOpts {
  collection: string
  path: string
  linkTo: string
}

/**
 * Record with its content
 */
export interface RecordWithContent {
  uri: string
  cid: string
  value: Record<string, unknown>
}

/**
 * Full record with metadata
 */
export interface RecordWithMeta {
  uri: string
  cid: string
  value: Record<string, unknown>
  indexedAt: string
  takedownRef: string | null
  sig: Buffer | null
}

/**
 * Reader for stratos records
 */
export class StratosRecordReader {
  constructor(
    protected db: StratosDbOrTx,
    protected cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    protected logger?: Logger,
  ) {}

  async recordCount(): Promise<number> {
    const res = await this.db
      .select({ count: countAll })
      .from(stratosRecord)
      .limit(1)
    return res[0]?.count ?? 0
  }

  async listAll(): Promise<StratosRecordDescript[]> {
    const records: StratosRecordDescript[] = []
    let cursor: string | undefined = ''
    while (cursor !== undefined) {
      const res = await this.db
        .select({ uri: stratosRecord.uri, cid: stratosRecord.cid })
        .from(stratosRecord)
        .where(gt(stratosRecord.uri, cursor))
        .orderBy(asc(stratosRecord.uri))
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
      .select({ collection: stratosRecord.collection })
      .from(stratosRecord)
      .groupBy(stratosRecord.collection)

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

    const conditions = [eq(stratosRecord.collection, collection)]

    if (!includeSoftDeleted) {
      conditions.push(isNull(stratosRecord.takedownRef))
    }

    // prioritize cursor but fall back to rkey start/end
    if (cursor !== undefined) {
      if (reverse) {
        conditions.push(gt(stratosRecord.rkey, cursor))
      } else {
        conditions.push(lt(stratosRecord.rkey, cursor))
      }
    } else {
      if (rkeyStart !== undefined) {
        conditions.push(gt(stratosRecord.rkey, rkeyStart))
      }
      if (rkeyEnd !== undefined) {
        conditions.push(lt(stratosRecord.rkey, rkeyEnd))
      }
    }

    const res = await this.db
      .select({
        uri: stratosRecord.uri,
        cid: stratosRecord.cid,
        content: stratosRepoBlock.content,
      })
      .from(stratosRecord)
      .innerJoin(stratosRepoBlock, eq(stratosRepoBlock.cid, stratosRecord.cid))
      .where(and(...conditions))
      .orderBy(reverse ? asc(stratosRecord.rkey) : desc(stratosRecord.rkey))
      .limit(limit)

    return res.map((row) => {
      return {
        uri: row.uri,
        cid: row.cid,
        value: this.cborToRecord(row.content),
      }
    })
  }

  async getRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted = false,
  ): Promise<RecordWithMeta | null> {
    const conditions = [eq(stratosRecord.uri, uri.toString())]

    if (!includeSoftDeleted) {
      conditions.push(isNull(stratosRecord.takedownRef))
    }
    if (cid) {
      conditions.push(eq(stratosRecord.cid, cid))
    }

    const res = await this.db
      .select({
        uri: stratosRecord.uri,
        cid: stratosRecord.cid,
        indexedAt: stratosRecord.indexedAt,
        takedownRef: stratosRecord.takedownRef,
        sig: stratosRecord.sig,
        content: stratosRepoBlock.content,
      })
      .from(stratosRecord)
      .innerJoin(stratosRepoBlock, eq(stratosRepoBlock.cid, stratosRecord.cid))
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
      sig: record.sig as Buffer | null,
    }
  }

  async hasRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted = false,
  ): Promise<boolean> {
    const conditions = [eq(stratosRecord.uri, uri.toString())]

    if (!includeSoftDeleted) {
      conditions.push(isNull(stratosRecord.takedownRef))
    }
    if (cid) {
      conditions.push(eq(stratosRecord.cid, cid))
    }

    const res = await this.db
      .select({ uri: stratosRecord.uri })
      .from(stratosRecord)
      .where(and(...conditions))
      .limit(1)

    return res.length > 0
  }

  async getRecordTakedownStatus(uri: AtUri): Promise<StatusAttr | null> {
    const res = await this.db
      .select({ takedownRef: stratosRecord.takedownRef })
      .from(stratosRecord)
      .where(eq(stratosRecord.uri, uri.toString()))
      .limit(1)

    if (res.length === 0) return null
    return res[0].takedownRef
      ? { applied: true, ref: res[0].takedownRef }
      : { applied: false }
  }

  async getCurrentRecordCid(uri: AtUri): Promise<CID | null> {
    const res = await this.db
      .select({ cid: stratosRecord.cid })
      .from(stratosRecord)
      .where(eq(stratosRecord.uri, uri.toString()))
      .limit(1)

    return res.length > 0 ? CID.parse(res[0].cid) : null
  }

  async getRecordBacklinks(opts: GetBacklinksOpts) {
    const { collection, path, linkTo } = opts
    return await this.db
      .select({
        uri: stratosRecord.uri,
        cid: stratosRecord.cid,
        collection: stratosRecord.collection,
        rkey: stratosRecord.rkey,
        repoRev: stratosRecord.repoRev,
        indexedAt: stratosRecord.indexedAt,
        takedownRef: stratosRecord.takedownRef,
      })
      .from(stratosRecord)
      .innerJoin(stratosBacklink, eq(stratosBacklink.uri, stratosRecord.uri))
      .where(
        and(
          eq(stratosBacklink.path, path),
          eq(stratosBacklink.linkTo, linkTo),
          eq(stratosRecord.collection, collection),
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

/**
 * Extracts backlinks from a stratos record
 */
export function getStratosBacklinks(
  uri: AtUri,
  record: Record<string, unknown>,
): StratosBacklink[] {
  const backlinks: StratosBacklink[] = []

  // Extract subject references
  const subject = record?.['subject']
  if (typeof subject === 'string') {
    try {
      syntax.ensureValidDid(subject)
      backlinks.push({
        uri: uri.toString(),
        path: 'subject',
        linkTo: subject,
      })
    } catch {
      // Not a valid DID, try as AT-URI
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
