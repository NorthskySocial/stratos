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
    commitCid: string
    rev: string
    trace?: SequenceTrace
  },
) {
  // Sequence the change for subscriptions
  const event: LexValue = {
    action: op.action,
    path: new AtUriSyntax(op.uri).pathname,
    cid: op.cid,
    record: op.record as LexValue | undefined,
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
