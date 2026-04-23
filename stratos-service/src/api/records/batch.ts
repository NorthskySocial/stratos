import { type Cid as CID } from '@atproto/lex-data'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { TID } from '@atproto/common-web'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { ActorTransactor } from '../../actor-store-types.js'
import {
  buildCommit,
  computeCid,
  encodeRecord,
  MstWriteOp,
  parseCid,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context.js'
import { signAndPersistCommit, StratosBlockStoreReader } from '../../features'
import {
  assertRootUnchanged,
  validateWritableRecord,
  withConcurrencyRetry,
} from './validation.js'
import {
  type BatchWriteResult,
  type CommitResult,
  sequenceChange,
  type SequenceTrace,
} from './types.js'
import { ensureActorStoreExists } from './util.js'

export type BatchAction = 'create' | 'update' | 'delete'

export interface BatchWriteOp {
  action: BatchAction
  collection: string
  rkey: string
  record?: unknown
}

export interface PrecomputedBatchOp {
  op: BatchWriteOp
  rkey: string
  uriStr: string
  uri: string
  action: BatchAction
  recordBytes?: Uint8Array
  cid?: CID
  tempRev?: string
}

/**
 * Pre-compute CPU-bound work outside the transaction
 * @param ctx - Application context
 * @param callerDid - DID of the caller
 * @param ops - Batch write operations
 */
async function calculatePrecomputed(
  ctx: AppContext,
  callerDid: string,
  ops: BatchWriteOp[],
): Promise<PrecomputedBatchOp[]> {
  return await Promise.all(
    ops.map(async (op): Promise<PrecomputedBatchOp> => {
      const rkey = op.action === 'create' ? op.rkey || TID.nextStr() : op.rkey
      const uriStr = `at://${callerDid}/${op.collection}/${rkey}`
      const uri = new AtUriSyntax(uriStr)

      if (op.action === 'delete') {
        return {
          op,
          rkey,
          uriStr,
          uri: uri.toString(),
          action: 'delete' as const,
        }
      }

      await validateWritableRecord(ctx, callerDid, op.collection, op.record)
      const recordBytes = encodeRecord(op.record)
      const cid = await computeCid(op.record)
      const tempRev = TID.nextStr()
      return {
        op,
        rkey,
        uriStr,
        uri: uri.toString(),
        action: op.action,
        recordBytes,
        cid,
        tempRev,
      }
    }),
  )
}

/**
 * Build MST ops from precomputed data
 *
 * @param precomputed - Precomputed data for batch write operations
 * @returns Array of MST write operations
 */
function buildMstOps(precomputed: PrecomputedBatchOp[]): MstWriteOp[] {
  return precomputed.map((pre) => ({
    action: pre.action,
    collection: pre.op.collection,
    rkey: pre.rkey,
    cid: pre.action === 'delete' ? null : parseCid(pre.cid!).toString(),
  }))
}

/**
 * Prepare write results for batch operations
 *
 * @param store - The actor transactor to use for persistence.
 * @param precomputed - Precomputed data for batch write operations
 * @param rev - The revision to use for indexing records
 * @returns Array of write results
 */
async function prepareWriteResults(
  store: {
    record: {
      deleteRecord(uri: AtUriSyntax): Promise<void>
      indexRecord(
        uri: AtUriSyntax,
        cid: CID,
        record: Record<string, unknown>,
        action: 'create' | 'update',
        rev: string,
      ): Promise<void>
    }
  },
  precomputed: PrecomputedBatchOp[],
  rev: string,
): Promise<BatchWriteResult[]> {
  const results: BatchWriteResult[] = []
  for (const pre of precomputed) {
    if (pre.action === 'delete') {
      await store.record.deleteRecord(new AtUriSyntax(pre.uriStr))
      results.push({})
    } else {
      await store.record.indexRecord(
        new AtUriSyntax(pre.uriStr),
        pre.cid!,
        pre.op.record as Record<string, unknown>,
        pre.action,
        rev,
      )
      results.push({ uri: pre.uriStr, cid: parseCid(pre.cid!).toString() })
    }
  }
  return results
}

/**
 * Build and commit with concurrency retry
 *
 * @param ctx - Application context
 * @param callerDid - DID of the caller
 * @param sequenceTrace - Sequence trace for the commit
 * @param mstOps - MST write operations
 * @param precomputed - Precomputed data for batch write operations
 * @returns Result of the batch write operation
 */
async function buildCommitWithRetry(
  ctx: AppContext,
  callerDid: string,
  sequenceTrace: SequenceTrace,
  mstOps: MstWriteOp[],
  precomputed: PrecomputedBatchOp[],
): Promise<CommitResult> {
  const actorSigningKey = await ctx.getActorSigningKey(callerDid)
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: CommitResult
  try {
    // Ensure actor store exists (inside mutex to prevent creation race)
    await ensureActorStoreExists(ctx.actorStore, callerDid)

    const retry = await withConcurrencyRetry(async () => {
      return ctx.actorStore.readThenTransact(
        callerDid,
        async (reader) => {
          const rootDetails = await reader.repo.getRootDetailed()
          const rootCid = rootDetails?.cid
            ? parseCid(rootDetails.cid).toString()
            : null
          const storage = new StratosBlockStoreReader(reader.repo)
          const unsigned = await buildCommit(storage, rootCid, {
            did: callerDid,
            writes: mstOps,
          })
          return { rootCid, unsigned }
        },
        async ({ rootCid, unsigned }, store) => {
          const currentRoot = await store.repo.lockRoot()
          assertRootUnchanged(
            currentRoot?.cid ? parseCid(currentRoot.cid).toString() : null,
            rootCid,
          )

          await persistBatchBlocks(store, precomputed)

          const commitResult = await signAndPersistCommit(
            store.repo,
            actorSigningKey,
            unsigned,
          )

          const results = await prepareWriteResults(
            store,
            precomputed,
            commitResult.rev,
          )

          await sequenceBatchChanges(
            store,
            precomputed,
            commitResult.commitCid.toString(),
            commitResult.rev,
            sequenceTrace,
          )

          for (const pre of precomputed) {
            if (pre.action === 'delete') {
              ctx.stubQueue.enqueueDelete(
                callerDid,
                pre.op.collection,
                pre.rkey,
              )
            } else {
              ctx.stubQueue.enqueueWrite(
                callerDid,
                pre.op.collection,
                pre.rkey,
                pre.op.collection,
                pre.cid!.toString(),
                commitResult.rev,
              )
            }
          }

          return {
            results,
            commit: {
              cid: commitResult.commitCid.toString(),
              rev: commitResult.rev,
            },
          }
        },
      )
    }, ctx.logger)
    result = retry.result
  } finally {
    unlock()
  }

  return result
}

/**
 * Persist batch blocks to the Stratos block store
 * @param store - Actor transactor
 * @param precomputed - Precomputed batch operations
 * @throws InvalidRequestError if a record is not found during deletion
 */
async function persistBatchBlocks(
  store: ActorTransactor,
  precomputed: PrecomputedBatchOp[],
): Promise<void> {
  for (const pre of precomputed) {
    if (pre.action === 'delete') {
      const existing = await store.record.getRecord(
        new AtUriSyntax(pre.uri),
        null,
      )
      if (!existing) {
        throw new InvalidRequestError('Record not found', 'RecordNotFound')
      }
    } else {
      await store.repo.putBlock(pre.cid!, pre.recordBytes!, pre.tempRev!)
    }
  }
}

/**
 * Sequence batch changes in the actor store
 * @param store - Actor transactor
 * @param precomputed - Precomputed batch operations
 * @param commitCid - CID of the commit
 * @param rev - The revision to use for indexing records
 * @param sequenceTrace - Sequence trace for the batch operation
 */
async function sequenceBatchChanges(
  store: ActorTransactor,
  precomputed: PrecomputedBatchOp[],
  commitCid: string,
  rev: string,
  sequenceTrace: SequenceTrace,
): Promise<void> {
  // Sequence all changes inline (same connection)
  for (const pre of precomputed) {
    await sequenceChange(store, {
      action: pre.action,
      uri: pre.uri,
      cid: pre.action !== 'delete' ? pre.cid!.toString() : undefined,
      record: pre.action !== 'delete' ? pre.op.record : undefined,
      commitCid,
      rev,
      trace: sequenceTrace,
    })
  }
}

/**
 * Apply batch write operations to the actor store
 * @param ctx - Application context
 * @param callerDid - DID of the caller
 * @param ops - Batch write operations
 * @param requestId - Optional request ID for tracking
 * @returns Batch write result
 */
export async function applyWritesBatch(
  ctx: AppContext,
  callerDid: string,
  ops: BatchWriteOp[],
  requestId?: string,
): Promise<CommitResult> {
  const sequenceTrace: SequenceTrace = {
    requestId,
    queuedAtMs: Date.now(),
  }
  ctx.writeRateLimiter.assertWriteAllowed(callerDid, ops.length)
  const precomputed: PrecomputedBatchOp[] = await calculatePrecomputed(
    ctx,
    callerDid,
    ops,
  )
  const mstOps: MstWriteOp[] = buildMstOps(precomputed)
  const result: Promise<CommitResult> = buildCommitWithRetry(
    ctx,
    callerDid,
    sequenceTrace,
    mstOps,
    precomputed,
  )
  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  return result
}
