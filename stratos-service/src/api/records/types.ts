import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { ActorTransactor } from '../../actor-store-types.js'
import { encode as cborEncode, type LexValue } from '@atproto/lex-cbor'

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
  // Sequence the change for subscriptions.
  // Path is canonicalized to `${collection}/${rkey}` (no leading slash) to
  // match the format produced by every other code path (postgres actor-store,
  // record reader, etc). AtUri.pathname has a leading slash which would break
  // downstream `path.startsWith('${collection}/')` checks.
  const uriPathname = new AtUriSyntax(op.uri).pathname
  const path = uriPathname.startsWith('/') ? uriPathname.slice(1) : uriPathname
  const event: LexValue = {
    action: op.action,
    path,
    cid: op.cid,
    record: op.record as LexValue | undefined,
    boundary: op.boundary as LexValue | undefined,
    excludeBoundary: op.excludeBoundary as LexValue | undefined,
    commit: op.commitCid,
    rev: op.rev,
    trace: op.trace as LexValue | undefined,
  }

  await store.sequence.appendEvent({
    did: store.did,
    eventType: 'append',
    event: Buffer.from(cborEncode(event)),
    invalidated: 0,
    sequencedAt: new Date().toISOString(),
  })
}
