import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { ActorTransactor } from '../../actor-store-types.js'
import { encode as cborEncode, type LexValue } from '@atproto/lex-cbor'
import type { Cid } from '@atproto/lex-data'
import type { RecordOp } from '../../subscription/subscribe-records.js'

export interface RecordWriteInput {
  callerDid: string
  boundary: string
  collection: string
  rkey: string
  record: Record<string, unknown>
}

/** A create or update the service sequences; it always carries its boundary. */
export interface BoundaryRecordWrite {
  action: 'create' | 'update'
  collection: string
  rkey: string
  record: unknown
  cid: Cid
  boundary: string
}

/** A delete the service sequences; it carries no boundary. */
export interface RecordDeleteWrite {
  action: 'delete'
  collection: string
  rkey: string
}

/** The writes the record handlers hand to the repo manager. */
export type RecordHandlerWrite = BoundaryRecordWrite | RecordDeleteWrite

/** The op-level boundary set sequenced for a single boundary. */
export function opBoundary(boundary: string): {
  values: Array<{ value: string }>
} {
  return { values: [{ value: boundary }] }
}

export interface WritePhases {
  enrollment?: number
  actorExists?: number
  validation?: number
  encode?: number
  connAcquire?: number
  prepareCommitGetRoot?: number
  prepareCommitBuild?: number
  transact?: number
  transactLockCheck?: number
  transactSign?: number
  transactPutBlocks?: number
  transactDeleteBlocks?: number
  transactUpdateRoot?: number
  transactPersist?: number
  retries?: number
}

export interface SequenceTrace {
  requestId?: string
  queuedAtMs?: number
}

export interface BatchWriteResult {
  uri?: string
  cid?: string
  validationStatus?: 'valid' | 'unknown'
}

export interface CommitResult {
  results: BatchWriteResult[]
  commit: { cid: string; rev: string }
}

export interface RecordResult {
  uri: string
  cid?: string
  value: unknown
}

export interface ListRecordsResult {
  records: RecordResult[]
  cursor?: string
}

/**
 * Sequence a change for subscriptions
 * @param store - Actor transactor store
 * @param op - Operation details for sequencing
 */
export async function sequenceChange(
  store: ActorTransactor,
  op: {
    action: 'create' | 'update' | 'delete'
    uri: string
    cid?: string
    record?: unknown
    /**
     * Explicit op-level boundary for scoped removals (e.g. a move's old-home
     * tombstone). Lets the event be gated to a domain WITHOUT inlining the
     * record body, so the removal is observed only by subscribers of the old
     * domain and never leaks content.
     */
    boundary?: { values: Array<{ value: string }> }
    /**
     * Domains in which the record STILL exists after this op (a move's new
     * home). A scoped removal is suppressed for any subscriber that shares one
     * of these, because that subscriber still sees the record via the retained
     * domain and must NOT observe a spurious deletion. Empty/absent for a full
     * delete.
     */
    excludeBoundary?: { values: Array<{ value: string }> }
    commitCid: string
    rev: string
    trace?: SequenceTrace
  },
) {
  const event: LexValue = {
    action: op.action,
    path: recordPath(op.uri),
    cid: op.cid,
    record: op.record as LexValue | undefined,
    boundary: op.boundary as LexValue | undefined,
    excludeBoundary: op.excludeBoundary as LexValue | undefined,
    commit: op.commitCid,
    rev: op.rev,
    trace: op.trace as LexValue | undefined,
  }

  await appendSequenceEvent(store, event)
}

/**
 * Sequences one commit as one event carrying every op in commit order, so
 * neither sync reader can split it.
 */
export async function sequenceCommit(
  store: ActorTransactor,
  commit: {
    ops: RecordOp[]
    commitCid: string
    rev: string
    trace?: SequenceTrace
  },
): Promise<void> {
  await appendSequenceEvent(store, {
    ops: commit.ops as unknown as LexValue,
    commit: commit.commitCid,
    rev: commit.rev,
    trace: commit.trace as LexValue | undefined,
  })
}

/**
 * The op path of a record URI, `${collection}/${rkey}` with no leading slash:
 * every other code path writes it that way, and readers match on
 * `path.startsWith('${collection}/')`.
 */
export function recordPath(uri: string): string {
  const uriPathname = new AtUriSyntax(uri).pathname
  return uriPathname.startsWith('/') ? uriPathname.slice(1) : uriPathname
}

async function appendSequenceEvent(
  store: ActorTransactor,
  event: LexValue,
): Promise<void> {
  await store.sequence.appendEvent({
    did: store.did,
    eventType: 'append',
    event: Buffer.from(cborEncode(event)),
    invalidated: 0,
    sequencedAt: new Date().toISOString(),
  })
}
