import { asc, desc, gt } from 'drizzle-orm'
import { type StratosDbOrTx, stratosSeq } from '@northskysocial/stratos-core'
import type { SequenceOperations } from '../../actor-store-types.js'

/**
 * SQLite sequence operations for Stratos actor store
 */
export class SqliteSequenceOps implements SequenceOperations {
  constructor(private db: StratosDbOrTx) {}

  /**
   * Get the latest sequence number from the database
   * @returns Latest sequence number, or 0 if no sequence events exist
   */
  async getLatestSeq(): Promise<number> {
    const rows = await this.db
      .select({ seq: stratosSeq.seq })
      .from(stratosSeq)
      .orderBy(desc(stratosSeq.seq))
      .limit(1)
    return rows[0]?.seq ?? 0
  }

  /**
   * Get the oldest sequence number from the database
   * @returns Oldest sequence number, or 0 if no sequence events exist
   */
  async getOldestSeq(): Promise<number> {
    const rows = await this.db
      .select({ seq: stratosSeq.seq })
      .from(stratosSeq)
      .orderBy(asc(stratosSeq.seq))
      .limit(1)
    return rows[0]?.seq ?? 0
  }

  /**
   * Get sequence events since a given cursor
   * @param cursor - Sequence number to start from
   * @param limit - Maximum number of events to retrieve (default: 100)
   * @returns Array of sequence events
   */
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
      .from(stratosSeq)
      .where(gt(stratosSeq.seq, cursor))
      .orderBy(asc(stratosSeq.seq))
      .limit(limit)
    return rows as Array<{
      seq: number
      did: string
      eventType: string
      event: Buffer
      invalidated: number
      sequencedAt: string
    }>
  }

  /**
   * Append a sequence event to the database
   *
   * @param event - Sequence event to append
   */
  async appendEvent(event: {
    did: string
    eventType: string
    event: Buffer
    invalidated: number
    sequencedAt: string
  }): Promise<void> {
    await this.db.insert(stratosSeq).values(event)
  }
}
