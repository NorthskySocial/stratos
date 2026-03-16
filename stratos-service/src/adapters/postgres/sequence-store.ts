import { eq, gt, and, lte, sql, asc, desc } from 'drizzle-orm'
import { decode as cborDecode } from '@atproto/lex-cbor'
import type {
  SequenceStoreReader,
  SequenceStoreWriter,
  SequenceEvent,
  SequenceEventType,
  GetEventsSinceOptions,
  AppendEventInput,
} from '@northskysocial/stratos-core'
import {
  type StratosPgDb,
  type StratosPgDbOrTx,
  pgStratosSeq,
} from '@northskysocial/stratos-core'

interface DecodedEvent {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: unknown
}

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

function rowToEvent(row: {
  seq: number
  did: string
  eventType: string
  event: Buffer
  sequencedAt: string
}): SequenceEvent {
  let decoded: DecodedEvent | null = null
  try {
    decoded = cborDecode(row.event) as unknown as DecodedEvent
  } catch {
    // Fallback for malformed events
  }

  const { collection, rkey } = decoded?.path
    ? parsePath(decoded!.path)
    : { collection: '', rkey: '' }

  return {
    seq: row.seq,
    did: row.did,
    eventType: row.eventType as SequenceEventType,
    collection,
    rkey,
    uri: `at://${row.did}/${collection}/${rkey}`,
    cid: decoded?.cid ?? null,
    rev: '',
    event: row.event,
    sequencedAt: row.sequencedAt,
  }
}

export class PgSequenceStoreReader implements SequenceStoreReader {
  constructor(protected db: StratosPgDb | StratosPgDbOrTx) {}

  async getLatestSeq(): Promise<number | null> {
    const rows = await this.db
      .select({ seq: pgStratosSeq.seq })
      .from(pgStratosSeq)
      .orderBy(desc(pgStratosSeq.seq))
      .limit(1)

    return rows[0]?.seq ?? null
  }

  async getEventsSince(
    seq: number,
    options?: GetEventsSinceOptions,
  ): Promise<SequenceEvent[]> {
    const limit = options?.limit ?? 1000

    const rows = await this.db
      .select()
      .from(pgStratosSeq)
      .where(gt(pgStratosSeq.seq, seq))
      .orderBy(asc(pgStratosSeq.seq))
      .limit(limit)

    return rows.map(rowToEvent)
  }

  async getEvent(seq: number): Promise<SequenceEvent | null> {
    const rows = await this.db
      .select()
      .from(pgStratosSeq)
      .where(eq(pgStratosSeq.seq, seq))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return rowToEvent(row)
  }

  async getEventsRange(
    startSeq: number,
    endSeq: number,
  ): Promise<SequenceEvent[]> {
    const rows = await this.db
      .select()
      .from(pgStratosSeq)
      .where(and(gt(pgStratosSeq.seq, startSeq), lte(pgStratosSeq.seq, endSeq)))
      .orderBy(asc(pgStratosSeq.seq))

    return rows.map(rowToEvent)
  }
}

export class PgSequenceStoreWriter
  extends PgSequenceStoreReader
  implements SequenceStoreWriter
{
  async appendEvent(event: AppendEventInput): Promise<number> {
    // PG SERIAL auto-increments; use RETURNING to get the assigned seq
    const rows = await this.db
      .insert(pgStratosSeq)
      .values({
        did: event.did,
        eventType: event.eventType,
        event: Buffer.from(event.event),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
      .returning({ seq: pgStratosSeq.seq })

    return rows[0].seq
  }

  async truncateBefore(seq: number): Promise<number> {
    const result = await this.db
      .delete(pgStratosSeq)
      .where(sql`${pgStratosSeq.seq} < ${seq}`)

    return (result as unknown as { rowCount?: number }).rowCount ?? 0
  }
}
