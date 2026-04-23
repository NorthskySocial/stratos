/**
 * SQLite Sequence Store Adapter
 *
 * Implements SequenceStoreReader/Writer for SQLite backend.
 * Note: The stratosSeq table stores minimal data. Collection/rkey/cid/rev
 * are decoded from the CBOR event blob when reading.
 */
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { decode as cborDecode } from '@atproto/lex-cbor'
import type {
  AppendEventInput,
  GetEventsSinceOptions,
  SequenceEvent,
  SequenceEventType,
  SequenceStoreReader,
  SequenceStoreWriter,
} from '@northskysocial/stratos-core'
import { type StratosDb, stratosSeq } from '@northskysocial/stratos-core'

/**
 * Decoded event payload from CBOR blob
 */
interface DecodedEvent {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: unknown
}

/**
 * Parse an event path into collection and rkey
 * @param path - Path like "zone.stratos.feed.post/3jui7kdu3ak2i"
 */
function parsePath(path: string): { collection: string; rkey: string } {
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash === -1) {
    return { collection: path, rkey: '' }
  }
  return {
    collection: path.substring(0, lastSlash),
    rkey: path.substring(lastSlash + 1),
  }
}

/**
 * Create a SequenceEvent from a database row
 *
 * @param row - Database row containing sequence event data
 * @returns SequenceEvent object
 */
function rowToEvent(row: {
  seq: number
  did: string
  eventType: string
  event: Buffer
  sequencedAt: string
}): SequenceEvent {
  // Decode CBOR event to extract collection/rkey/cid
  let decoded: DecodedEvent | null = null
  try {
    decoded = cborDecode(row.event) as unknown as DecodedEvent
  } catch {
    // Fallback for malformed events
  }

  const { collection, rkey } = decoded?.path
    ? parsePath(decoded.path)
    : { collection: '', rkey: '' }

  return {
    seq: row.seq,
    did: row.did,
    eventType: row.eventType as SequenceEventType,
    collection,
    rkey,
    uri: `at://${row.did}/${collection}/${rkey}`,
    cid: decoded?.cid ?? null,
    rev: '', // Not stored in the current schema
    event: row.event,
    sequencedAt: row.sequencedAt,
  }
}

/**
 * SQLite implementation of SequenceStoreReader
 */
export class SqliteSequenceStoreReader implements SequenceStoreReader {
  constructor(protected db: StratosDb) {}

  /**
   * Get the latest sequence number from the database
   * @returns Latest sequence number or null if no events found
   */
  async getLatestSeq(): Promise<number | null> {
    const rows = await this.db
      .select({ seq: stratosSeq.seq })
      .from(stratosSeq)
      .orderBy(desc(stratosSeq.seq))
      .limit(1)

    return rows[0]?.seq ?? null
  }

  /**
   * Get sequence events since a given sequence number
   * @param seq - Starting sequence number
   * @param options - Optional parameters
   * @returns Array of SequenceEvent objects
   */
  async getEventsSince(
    seq: number,
    options?: GetEventsSinceOptions,
  ): Promise<SequenceEvent[]> {
    const limit = options?.limit ?? 1000

    const rows = await this.db
      .select()
      .from(stratosSeq)
      .where(gt(stratosSeq.seq, seq))
      .orderBy(asc(stratosSeq.seq))
      .limit(limit)

    return rows.map(rowToEvent)
  }

  /**
   * Get a specific sequence event by sequence number
   * @param seq - Sequence number of the event
   * @returns SequenceEvent object or null if not found
   */
  async getEvent(seq: number): Promise<SequenceEvent | null> {
    const rows = await this.db
      .select()
      .from(stratosSeq)
      .where(eq(stratosSeq.seq, seq))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return rowToEvent(row)
  }

  /**
   * Get a range of sequence events between two sequence numbers
   * @param startSeq - Starting sequence number
   * @param endSeq - Ending sequence number
   * @param _options - Not used in SQLite implementation
   * @returns Array of SequenceEvent objects
   */
  async getEventsRange(
    startSeq: number,
    endSeq: number,
    _options?: GetEventsSinceOptions,
  ): Promise<SequenceEvent[]> {
    const rows = await this.db
      .select()
      .from(stratosSeq)
      .where(and(gt(stratosSeq.seq, startSeq), lte(stratosSeq.seq, endSeq)))
      .orderBy(asc(stratosSeq.seq))

    return rows.map(rowToEvent)
  }
}

/**
 * SQLite implementation of SequenceStoreWriter
 */
export class SqliteSequenceStoreWriter
  extends SqliteSequenceStoreReader
  implements SequenceStoreWriter
{
  /**
   * Append a sequence event to the store
   * @param event - Event to append
   * @returns Sequence number of the appended event
   */
  async appendEvent(event: AppendEventInput): Promise<number> {
    // Get next seq number
    const latestSeq = await this.getLatestSeq()
    const nextSeq = (latestSeq ?? 0) + 1

    // Only insert columns that exist in the schema
    // collection/rkey/cid/rev are encoded in the event blob
    await this.db.insert(stratosSeq).values({
      seq: nextSeq,
      did: event.did,
      eventType: event.eventType,
      event: Buffer.from(event.event),
      invalidated: 0,
      sequencedAt: new Date().toISOString(),
    })

    return nextSeq
  }

  /**
   * Truncate sequence events before a given sequence number
   * @param seq - Sequence number to truncate before
   * @returns Number of affected rows (always 0 for SQLite)
   */
  async truncateBefore(seq: number): Promise<number> {
    await this.db.delete(stratosSeq).where(sql`${stratosSeq.seq} < ${seq}`)

    // drizzle-orm doesn't have a clean way to get affected rows count for SQLite
    // so we return 0 (caller can check latestSeq before/after if needed)
    return 0
  }
}
