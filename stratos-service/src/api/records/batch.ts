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
  assertCollectionInHostedSpaceType,
  authorizeRecordBoundary,
  validateLegacyRecordContent,
  withConcurrencyRetry,
} from './validation.js'
import {
  type BatchWriteResult,
  type CommitResult,
  opBoundary,
  type RecordWriteInput,
  sequenceChange,
  type SequenceTrace,
} from './types.js'
import { ensureActorStoreExists } from './util.js'
import {
  assertStratosCustody,
  assertWritableEnrollment,
  assertWriterStillAuthorized,
} from './custody.js'

export type BatchAction = 'create' | 'update' | 'delete'

export interface BatchWriteOp {
  action: BatchAction
  collection: string
  rkey: string
  record?: unknown
}

interface PrecomputedBatchOpBase {
  op: BatchWriteOp
  rkey: string
  uriStr: string
  uri: string
  /**
   * Domains the record held BEFORE this op, captured inside the transaction for
   * update ops so a domain change (move) can emit a boundary-carrying removal,
   * and for delete ops so a scoped removal can be sequenced.
   */
  previousDomains?: string[]
}

export interface PrecomputedDeleteOp extends PrecomputedBatchOpBase {
  action: 'delete'
}

/** A create or update; every op that is not a delete is treated as one. */
export interface PrecomputedWriteOp extends PrecomputedBatchOpBase {
  action: 'create' | 'update'
  writeInput: RecordWriteInput
  recordBytes: Uint8Array
  cid: CID
}

export type PrecomputedBatchOp = PrecomputedDeleteOp | PrecomputedWriteOp

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

      await validateLegacyRecordContent(ctx, op.collection, op.record)
      const boundary = await authorizeRecordBoundary(
        ctx,
        callerDid,
        op.collection,
        op.record,
      )
      const recordBytes = encodeRecord(op.record)
      const cid = await computeCid(op.record)
      return {
        op,
        rkey,
        uriStr,
        uri: uri.toString(),
        action: op.action,
        writeInput: {
          callerDid,
          boundary,
          collection: op.collection,
          rkey,
          record: op.record as Record<string, unknown>,
        },
        recordBytes,
        cid,
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
    cid: pre.action === 'delete' ? null : parseCid(pre.cid).toString(),
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
      indexRecordInBoundary(
        uri: AtUriSyntax,
        cid: CID,
        record: Record<string, unknown>,
        boundary: string,
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
      const { record, boundary } = pre.writeInput
      await store.record.indexRecordInBoundary(
        new AtUriSyntax(pre.uriStr),
        pre.cid,
        record,
        boundary,
        pre.action,
        rev,
      )
      results.push({ uri: pre.uriStr, cid: parseCid(pre.cid).toString() })
    }
  }
  return results
}

/** The distinct boundaries the batch writes into; deletes name none. */
function writeBoundaries(precomputed: PrecomputedBatchOp[]): Set<string> {
  return new Set(
    precomputed.flatMap((pre) =>
      pre.action === 'delete' ? [] : [pre.writeInput.boundary],
    ),
  )
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
  const actorSign = await ctx.actorSigner.getSignFn(callerDid)
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: CommitResult
  try {
    for (const boundary of writeBoundaries(precomputed)) {
      await assertWriterStillAuthorized(ctx, callerDid, boundary)
    }
    // Ensure actor store exists (inside mutex to prevent creation race)
    await ensureActorStoreExists(ctx.actorStore, callerDid)

    const retry = await withConcurrencyRetry(async () => {
      // WARNING: Use transact() — not readThenTransact(). lockRoot() (FOR UPDATE)
      // provides the root and row lock in one query; a separate read phase doubles
      // the root query and loses the lock. See create.ts for full rationale.
      return ctx.actorStore.transact(callerDid, async (store) => {
        const currentRoot = await store.repo.lockRoot()
        const rootCid = currentRoot?.cid
          ? parseCid(currentRoot.cid).toString()
          : null
        const storage = new StratosBlockStoreReader(store.repo)
        const unsigned = await buildCommit(storage, rootCid, {
          did: callerDid,
          writes: mstOps,
        })

        await persistBatchBlocks(store, precomputed, unsigned.rev)

        const commitResult = await signAndPersistCommit(
          store.repo,
          actorSign,
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

        return {
          results,
          commit: {
            cid: commitResult.commitCid.toString(),
            rev: commitResult.rev,
          },
        }
      })
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
 * @param rev - The revision of the commit the record blocks belong to
 * @throws InvalidRequestError if a record is not found during deletion
 */
async function persistBatchBlocks(
  store: ActorTransactor,
  precomputed: PrecomputedBatchOp[],
  rev: string,
): Promise<void> {
  for (const pre of precomputed) {
    if (pre.action === 'delete') {
      // A taken-down record must stay deletable so consumers drop their copy.
      const existing = await store.record.getRecord(
        new AtUriSyntax(pre.uri),
        null,
        true,
      )
      if (!existing) {
        throw new InvalidRequestError('Record not found', 'RecordNotFound')
      }
      // Capture the deleted record's domains so a boundary-carrying removal can
      // be sequenced (a plain delete op carries no boundary and is otherwise
      // invisible to every subscriber). The stored rows are the boundary; the
      // body only claims one.
      pre.previousDomains = await store.record.getRecordBoundaries(
        new AtUriSyntax(pre.uri),
      )
    } else {
      if (pre.action === 'update') {
        // Capture pre-update domains so a move can emit a scoped removal.
        pre.previousDomains = await store.record.getRecordBoundaries(
          new AtUriSyntax(pre.uri),
        )
      }
      await store.repo.putBlock(pre.cid, pre.recordBytes, rev)
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
    if (pre.action === 'delete') {
      await sequenceChange(store, {
        action: 'delete',
        uri: pre.uri,
        commitCid,
        rev,
        trace: sequenceTrace,
      })
      // A plain delete op carries no boundary, so the event above is dropped by
      // the fail-closed scope gate for every subscriber. Emit a boundary-carrying
      // removal scoped to the record's domains so members that could see the
      // record observe the deletion (and only them). See update.ts.
      const domains = pre.previousDomains ?? []
      if (domains.length > 0) {
        await sequenceChange(store, {
          action: 'delete',
          uri: pre.uri,
          boundary: { values: domains.map((value) => ({ value })) },
          commitCid,
          rev,
          trace: sequenceTrace,
        })
      }
      continue
    }

    await sequenceChange(store, {
      action: pre.action,
      uri: pre.uri,
      cid: pre.cid.toString(),
      record: pre.op.record,
      boundary: opBoundary(pre.writeInput.boundary),
      commitCid,
      rev,
      trace: sequenceTrace,
    })

    // A move (update that changes domains) emits a boundary-carrying removal
    // scoped to each domain the record left, sharing this op's rev. See
    // update.ts:sequenceMoveRemovals for the full rationale.
    const removedDomains = computeRemovedDomains(pre)
    if (removedDomains.length > 0) {
      await sequenceChange(store, {
        action: 'delete',
        uri: pre.uri,
        boundary: { values: removedDomains.map((value) => ({ value })) },
        // Suppress the removal for subscribers who still see the record via its
        // new domain(s) — they must observe the update, not a deletion.
        excludeBoundary: opBoundary(pre.writeInput.boundary),
        commitCid,
        rev,
        trace: sequenceTrace,
      })
    }
  }
}

/**
 * Domains an update op removed relative to its pre-update state (a move).
 * Returns an empty array for creates, deletes, and updates that keep their
 * domain.
 *
 * @param pre - A precomputed batch op with `previousDomains` populated.
 * @returns The domains the record left.
 */
function computeRemovedDomains(pre: PrecomputedBatchOp): string[] {
  if (pre.action !== 'update' || !pre.previousDomains?.length) return []
  const newBoundary = pre.writeInput.boundary
  return pre.previousDomains.filter((domain) => domain !== newBoundary)
}

function assertStratosNamespaceCollection(collection: string): void {
  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
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
  for (const op of ops) {
    assertCollectionInHostedSpaceType(op.collection)
  }
  // After the type check, so a collection the type does not list keeps the
  // message it always had; only a listed collection outside zone.stratos.*
  // (the interactions of the boundary procedures) reaches this gate.
  for (const op of ops) {
    assertStratosNamespaceCollection(op.collection)
  }

  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  assertWritableEnrollment(enrollment)
  assertStratosCustody(enrollment)

  const precomputed: PrecomputedBatchOp[] = await calculatePrecomputed(
    ctx,
    callerDid,
    ops,
  )
  const mstOps: MstWriteOp[] = buildMstOps(precomputed)
  const result = await buildCommitWithRetry(
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
