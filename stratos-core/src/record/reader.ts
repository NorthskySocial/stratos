import type { Cid } from '@atproto/lex-data'
import { parseCid } from '../atproto/index.js'
import * as syntax from '@atproto/syntax'
import { AtUri } from '@atproto/syntax'
import { and, asc, desc, eq, gt, isNull, lt } from 'drizzle-orm'
import {
  countAll,
  StratosBacklink,
  stratosBacklink,
  StratosDbOrTx,
  StratosRecord,
  stratosRecord,
  stratosRepoBlock,
} from '../db/index.js'
import { Logger, StatusAttr } from '../types.js'

/**
 * Descriptor for a stratos record
 */
export interface StratosRecordDescript {
  uri: string
  path: string
  cid: Cid
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
}

/**
 * Reader for stratos records
 */
export class StratosRecordReader {
  constructor(
    public readonly db: StratosDbOrTx,
    protected cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    protected logger?: Logger,
  ) {}

  /**
   * Counts the total number of records in the database.
   * @returns The total number of records.
   */
  async recordCount(): Promise<number> {
    const res = await this.db
      .select({ count: countAll })
      .from(stratosRecord)
      .limit(1)
    return res[0]?.count ?? 0
  }

  /**
   * Lists all records in the database.
   * @returns An array of StratosRecordDescript objects representing all records.
   */
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
          cid: parseCid(row.cid),
        })
      }
      cursor = res.at(-1)?.uri
    }
    return records
  }

  /**
   * Lists all unique collections in the database.
   * @returns An array of collection names.
   */
  async listCollections(): Promise<string[]> {
    const collections = await this.db
      .select({ collection: stratosRecord.collection })
      .from(stratosRecord)
      .groupBy(stratosRecord.collection)

    return collections.map((row: { collection: string }) => row.collection)
  }

  /**
   * Lists all records for a specific collection in the database.
   * @param opts - Options for listing records.
   * @returns An array of RecordWithContent objects representing records in the collection.
   */
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

    return res.map((row: { uri: string; cid: string; content: Uint8Array }) => {
      return {
        uri: row.uri,
        cid: row.cid,
        value: this.cborToRecord(row.content),
      }
    })
  }

  /**
   * Retrieves a specific record from the database by URI and optional CID.
   * @param uri - The URI of the record to retrieve.
   * @param cid - The CID of the record to retrieve (optional).
   * @param includeSoftDeleted - Whether to include soft-deleted records (default: false).
   * @returns The record with metadata, or null if not found.
   */
  async getRecord(
    uri: string | AtUri,
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
        content: stratosRepoBlock.content,
      })
      .from(stratosRecord)
      .innerJoin(stratosRepoBlock, eq(stratosRepoBlock.cid, stratosRecord.cid))
      .where(and(...conditions))
      .limit(1)

    if (res.length === 0) return null
    const record = res[0]
    return {
      uri: record.uri,
      cid: record.cid,
      value: this.cborToRecord(record.content),
      indexedAt: record.indexedAt,
      takedownRef: record.takedownRef ? record.takedownRef.toString() : null,
    }
  }

  /**
   * Checks if a record exists in the database by URI and optional CID.
   * @param uri - The URI of the record to check.
   * @param cid - The CID of the record to check (optional).
   * @param includeSoftDeleted - Whether to include soft-deleted records (default: false).
   * @returns True if the record exists, false otherwise.
   */
  async hasRecord(
    uri: string | AtUri,
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

  /**
   * Retrieves the takedown status of a record by URI.
   * @param uri - The URI of the record to check.
   * @returns The takedown status of the record, or null if not found.
   */
  async getRecordTakedownStatus(
    uri: string | AtUri,
  ): Promise<StatusAttr | null> {
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

  /**
   * Retrieves the CID of the current version of a record by URI.
   * @param uri - The URI of the record to retrieve the CID for.
   * @returns The CID of the current version of the record, or null if not found.
   */
  async getCurrentRecordCid(uri: string | AtUri): Promise<Cid | null> {
    const res = await this.db
      .select({ cid: stratosRecord.cid })
      .from(stratosRecord)
      .where(eq(stratosRecord.uri, uri.toString()))
      .limit(1)

    return res.length > 0 ? parseCid(res[0].cid) : null
  }

  /**
   * Retrieves backlinks for a record based on the provided options.
   * @param opts - Options for retrieving backlinks.
   * @returns An array of backlinks for the specified record.
   */
  async getRecordBacklinks(opts: GetBacklinksOpts): Promise<StratosRecord[]> {
    const { collection, path, linkTo } = opts
    return this.db
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

  /**
   * Retrieves conflicts for a record based on backlinks.
   * @param uri - The URI of the record to check for conflicts.
   * @param record - The record object to analyze for backlinks.
   * @returns An array of conflicting URIs.
   */
  async getBacklinkConflicts(
    uri: AtUri | string,
    record: Record<string, unknown>,
  ): Promise<AtUri[]> {
    const conflicts: AtUri[] = []
    const atUri = typeof uri === 'string' ? new AtUri(uri) : uri

    for (const backlink of getStratosBacklinks(atUri, record)) {
      const backlinks = await this.getRecordBacklinks({
        collection: atUri.collection,
        path: backlink.path,
        linkTo: backlink.linkTo,
      })

      for (const row of backlinks) {
        conflicts.push(AtUri.make(atUri.hostname, atUri.collection, row.rkey))
      }
    }

    return conflicts
  }
}

/**
 * Extracts backlinks from a stratos record
 *
 * @param uri - The URI of the record to extract backlinks from.
 * @param record - The record object to analyze for backlinks.
 * @returns An array of backlinks found in the record.
 */
export function getStratosBacklinks(
  uri: AtUri | string,
  record: Record<string, unknown>,
): StratosBacklink[] {
  const backlinks: StratosBacklink[] = []

  // Extract subject references
  const subject = record['subject']
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
