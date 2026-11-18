import type { Cid } from '@atproto/lex-data'
import { parseCid } from '../atproto'
import * as syntax from '@atproto/syntax'
import { AtUri } from '@atproto/syntax'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  type SQL,
  sql,
} from 'drizzle-orm'
import {
  countAll,
  StratosBacklink,
  stratosBacklink,
  StratosDbOrTx,
  StratosRecord,
  stratosRecord,
  stratosRecordBoundary,
  stratosRepoBlock,
} from '../db'
import { formatRecordUri, parseRecordUri } from '../spaces/domain.js'
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
 * A record that is not taken down, with the boundary rows stored for it.
 */
export interface VisibleRecordWithBoundaries {
  record: RecordWithMeta
  boundaries: string[]
}

/**
 * The most URIs one `getVisibleRecordsWithBoundaries` call accepts; callers
 * chunk longer lists.
 */
export const MAX_VISIBLE_RECORD_BATCH = 100

const normalizeRecordUri = (uri: AtUri | string): string =>
  new AtUri(uri.toString()).toString()

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
      let rkey = cursor
      if (cursor.startsWith('at://')) {
        try {
          const atUri = new AtUri(cursor)
          rkey = atUri.rkey
        } catch (err) {
          // Fall back to using the cursor as-is if it's not a valid AtUri
          this.logger?.warn({ cursor, err }, 'failed to parse cursor as AtUri')
        }
      }

      if (reverse) {
        conditions.push(lt(stratosRecord.rkey, rkey))
      } else {
        conditions.push(gt(stratosRecord.rkey, rkey))
      }
    } else {
      if (rkeyStart !== undefined) {
        conditions.push(gte(stratosRecord.rkey, rkeyStart))
      }
      if (rkeyEnd !== undefined) {
        conditions.push(lte(stratosRecord.rkey, rkeyEnd))
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
      .orderBy(reverse ? desc(stratosRecord.rkey) : asc(stratosRecord.rkey))
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
      takedownRef: record.takedownRef,
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
   * Reads, in one query, the takedown state of each given record URI.
   * @param uris - Record URIs to check.
   * @returns `true` for a row with a takedown marker, `false` for a row
   * without one. A URI with no row is absent.
   */
  async getTakedownStates(uris: string[]): Promise<Map<string, boolean>> {
    if (uris.length === 0) return new Map()
    const rows = await this.db
      .select({
        uri: stratosRecord.uri,
        takedownRef: stratosRecord.takedownRef,
      })
      .from(stratosRecord)
      .where(inArray(stratosRecord.uri, uris))
    return new Map(rows.map((row) => [row.uri, row.takedownRef !== null]))
  }

  async getRecordBoundaries(uri: string | AtUri): Promise<string[]> {
    const rows = await this.db
      .select({ boundary: stratosRecordBoundary.boundary })
      .from(stratosRecordBoundary)
      .where(eq(stratosRecordBoundary.recordUri, uri.toString()))
      .orderBy(asc(stratosRecordBoundary.boundary))
    return rows.map((row) => row.boundary)
  }

  /**
   * Reads a record together with its boundary rows in one statement, so the
   * body and the rows always belong to the same moment.
   * @param uri - The URI of the record.
   * @returns The record and its stored boundaries, or null when the record is
   * missing or taken down.
   */
  async getVisibleRecordWithBoundaries(
    uri: AtUri | string,
  ): Promise<VisibleRecordWithBoundaries | null> {
    const found = await this.getVisibleRecordsWithBoundaries([uri])
    return found.get(normalizeRecordUri(uri)) ?? null
  }

  /**
   * Batch form of {@link getVisibleRecordWithBoundaries}, still one statement.
   * @param uris - At most {@link MAX_VISIBLE_RECORD_BATCH} record URIs.
   * @returns The visible records keyed by normalized URI. Missing and
   * taken-down records are absent.
   * @throws When more than {@link MAX_VISIBLE_RECORD_BATCH} URIs are given.
   */
  async getVisibleRecordsWithBoundaries(
    uris: readonly (AtUri | string)[],
  ): Promise<Map<string, VisibleRecordWithBoundaries>> {
    if (uris.length > MAX_VISIBLE_RECORD_BATCH) {
      throw new RangeError(
        `at most ${MAX_VISIBLE_RECORD_BATCH} uris per call, got ${uris.length}`,
      )
    }
    const normalized = [...new Set(uris.map(normalizeRecordUri))]
    if (normalized.length === 0) return new Map()

    const boundaryColumn = stratosRecordBoundary.boundary
    const rows = await this.db
      .select({
        uri: stratosRecord.uri,
        cid: stratosRecord.cid,
        indexedAt: stratosRecord.indexedAt,
        takedownRef: stratosRecord.takedownRef,
        content: stratosRepoBlock.content,
        boundaries: sql<string>`json_group_array(distinct ${boundaryColumn} order by ${boundaryColumn}) filter (where ${boundaryColumn} is not null)`,
      })
      .from(stratosRecord)
      .innerJoin(stratosRepoBlock, eq(stratosRepoBlock.cid, stratosRecord.cid))
      .leftJoin(
        stratosRecordBoundary,
        eq(stratosRecordBoundary.recordUri, stratosRecord.uri),
      )
      .where(
        and(
          inArray(stratosRecord.uri, normalized),
          isNull(stratosRecord.takedownRef),
        ),
      )
      .groupBy(stratosRecord.uri)

    return new Map(
      rows.map((row) => [
        row.uri,
        {
          record: {
            uri: row.uri,
            cid: row.cid,
            value: this.cborToRecord(row.content),
            indexedAt: row.indexedAt,
            takedownRef: row.takedownRef,
          },
          boundaries: JSON.parse(row.boundaries) as string[],
        },
      ]),
    )
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
    return this.selectBacklinkRows(opts, isNull(stratosRecord.takedownRef))
  }

  /**
   * Conflict checks use the unfiltered rows so taken-down records still block.
   */
  private async selectBacklinkRows(
    opts: GetBacklinksOpts,
    extraCondition?: SQL,
  ): Promise<StratosRecord[]> {
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
          extraCondition,
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
      const backlinks = await this.selectBacklinkRows({
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
    const subjectUri = (subject as Record<string, unknown>)['uri'] as string
    const linkTo = subjectLinkTarget(subjectUri)
    if (linkTo !== null) {
      backlinks.push({ uri: uri.toString(), path: 'subject.uri', linkTo })
    }
  }

  return backlinks
}

/**
 * The string a `subject.uri` is indexed under: an at-uri as written, or a
 * space record uri in its canonical form (the installed at-uri syntax rejects
 * the space form, so it needs its own parser).
 */
function subjectLinkTarget(subjectUri: string): string | null {
  try {
    syntax.ensureValidAtUri(subjectUri)
    return subjectUri
  } catch {
    const space = parseRecordUri(subjectUri)
    if (!space.ok) return null
    const canonical = formatRecordUri(space.value)
    return canonical.ok ? canonical.value : null
  }
}
