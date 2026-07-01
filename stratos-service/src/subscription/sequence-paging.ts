import { decode as cborDecode } from '@atproto/lex-cbor'
import type { AppContext } from '../context.js'
import { type SeqEvent } from './index.js'

/**
 * The database page size used when reading from the actor sequence store.
 * Matches the value used by the subscribeRecords actor-mode replay so both
 * paths exhibit identical paging behavior.
 */
export const SEQUENCE_DB_PAGE_SIZE = 100

/**
 * A single row read from an actor's sequence store, normalized into a
 * {@link SeqEvent} with its `rev` decoded from the CBOR payload.
 *
 * This is the same normalization the subscribeRecords actor-mode replay applies
 * (see `getEventsSince` in `subscribe-records.ts`); it is centralized here so
 * the pull-sync endpoints and the subscription share one decode path rather
 * than duplicating the actor-mode replay logic.
 *
 * @param row - Raw sequence row from `store.sequence.getEventsSince`
 * @returns Normalized sequence event with a best-effort decoded `rev`
 */
export function rowToSeqEvent(row: {
  seq: number
  did: string
  event: Buffer | Uint8Array
  sequencedAt: string
}): SeqEvent {
  let rev = ''
  try {
    const decoded = cborDecode(row.event) as Record<string, unknown>
    rev = (decoded.rev as string) ?? ''
  } catch {
    // Ignore decode errors; rev stays empty and gating fails closed downstream.
  }
  return {
    seq: row.seq,
    did: row.did,
    time: row.sequencedAt,
    rev,
    event: row.event,
  }
}

/**
 * Read a single page of sequence events for an actor, starting strictly after
 * `afterSeq`. Returns the events (oldest-first) exactly as the actor store
 * yields them, normalized to {@link SeqEvent} with decoded `rev`.
 *
 * Opening an actor store lazily materializes its SQLite file, so callers that
 * have already confirmed existence should pass a DID whose store exists; when it
 * does not exist an empty page is returned (never a fresh empty database).
 *
 * @param ctx - Application context
 * @param did - The repo DID to page
 * @param afterSeq - Return events with `seq` strictly greater than this
 * @param pageSize - DB page size (defaults to {@link SEQUENCE_DB_PAGE_SIZE})
 * @returns One page of normalized sequence events (may be empty)
 */
export async function readSequencePage(
  ctx: AppContext,
  did: string,
  afterSeq: number,
  pageSize: number = SEQUENCE_DB_PAGE_SIZE,
): Promise<SeqEvent[]> {
  if (!(await ctx.actorStore.exists(did))) return []
  return await ctx.actorStore.read(did, async (store) => {
    const rows = await store.sequence.getEventsSince(afterSeq, pageSize)
    return rows.map(rowToSeqEvent)
  })
}

/**
 * The oldest and latest retained sequence numbers for an actor, plus the
 * decoded `rev` of the oldest retained event. Used to decide whether a `since`
 * revision predates retained history (⇒ OplogTruncated).
 */
export interface SequenceBounds {
  oldestSeq: number
  latestSeq: number
  oldestRev: string
}

/**
 * Resolve the retention bounds of an actor's sequence log: the oldest and
 * latest `seq`, and the `rev` of the oldest retained event. Returns null when
 * the actor has no store or an empty log (nothing to truncate against).
 *
 * @param ctx - Application context
 * @param did - The repo DID
 * @returns The sequence bounds, or null when the log is empty/absent
 */
export async function getSequenceBounds(
  ctx: AppContext,
  did: string,
): Promise<SequenceBounds | null> {
  if (!(await ctx.actorStore.exists(did))) return null
  return await ctx.actorStore.read(did, async (store) => {
    const oldestSeq = await store.sequence.getOldestSeq()
    const latestSeq = await store.sequence.getLatestSeq()
    // An empty log reports oldest === latest === 0 with no rows.
    if (latestSeq === 0 && oldestSeq === 0) {
      const probe = await store.sequence.getEventsSince(-1, 1)
      if (probe.length === 0) return null
      return {
        oldestSeq: probe[0].seq,
        latestSeq: probe[0].seq,
        oldestRev: rowToSeqEvent(probe[0]).rev,
      }
    }
    // Read the single oldest event to decode its rev.
    const oldestRows = await store.sequence.getEventsSince(oldestSeq - 1, 1)
    const oldestRev =
      oldestRows.length > 0 ? rowToSeqEvent(oldestRows[0]).rev : ''
    return { oldestSeq, latestSeq, oldestRev }
  })
}
