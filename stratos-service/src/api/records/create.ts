import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { TID } from '@atproto/common-web'
import { AtUri } from '@atproto/syntax'
import {
  computeCid,
  encodeRecord,
  parseCid,
  RepoWrite,
  StratosValidator,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { ActorSignFn } from '../../infra/signing/index.js'
import {
  assertCollectionInHostedSpaceType,
  authorizeRecordBoundary,
  validateRecordContent,
  withConcurrencyRetry,
} from './validation.js'
import {
  type RecordWriteInput,
  type SequenceTrace,
  type WritePhases,
} from './types.js'
import { type Cid as CID } from '@atproto/lex-data'
import {
  createRepoManager,
  ensureActorStoreExists as ensureStoreExists,
} from './util.js'
import { assertStratosCustody, assertWritableEnrollment } from './custody.js'

export interface CreateRecordInput {
  repo: string
  collection: string
  rkey?: string
  record: unknown
  validate?: boolean
  swapCommit?: string
  requestId?: string
}

export interface CreateRecordOutput {
  uri: string
  cid: string
  commit?: {
    cid: string
    rev: string
  }
  validationStatus?: string
}

interface PrecomputedRecordData {
  uri: AtUri
  recordBytes: Uint8Array
  cid: CID
}

interface TransactionResult {
  uri: AtUri
  cid: CID
  commit?: {
    cid: string
    rev: string
  }
}

/**
 * Create a new record in the stratos store
 *
 * @param ctx - Application context
 * @param input - Input parameters for record creation
 * @param callerDid - DID of the caller
 * @returns Output containing URI, CID, and optional commit information
 */
export async function createRecord(
  ctx: AppContext,
  input: CreateRecordInput,
  callerDid: string,
): Promise<CreateRecordOutput & { phases?: WritePhases }> {
  const phases: WritePhases = {}
  const { collection, record } = input
  const sequenceTrace: SequenceTrace = {
    requestId: input.requestId,
    queuedAtMs: Date.now(),
  }

  await validateCreateInput(ctx, input, callerDid)

  // Check if enrolled
  let performanceTimer = performance.now()
  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  phases.enrollment = performance.now() - performanceTimer
  assertWritableEnrollment(enrollment)
  assertStratosCustody(enrollment)

  const actorSign = await ctx.actorSigner.getSignFn(callerDid)

  performanceTimer = performance.now()
  // `validate: false` cannot loosen any Stratos rule on this path: lexicon
  // errors are never fatal, and the business rules run on every write.
  await validateRecordContent(ctx, collection, record)
  const boundary = await authorizeRecordBoundary(
    ctx,
    callerDid,
    collection,
    record,
  )
  phases.validation = performance.now() - performanceTimer

  const rkey = input.rkey ?? TID.nextStr()
  const writeInput: RecordWriteInput = {
    callerDid,
    boundary,
    collection,
    rkey,
    record: record as Record<string, unknown>,
  }
  const precomputed = await precomputeRecordData(writeInput, phases)

  const result = await performCreateTransaction(
    ctx,
    writeInput,
    precomputed,
    actorSign,
    sequenceTrace,
    phases,
  )

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  return {
    uri: result.uri.toString(),
    cid: parseCid(result.cid).toString(),
    commit: result.commit,
    phases,
  }
}

/**
 * Pre-compute record data (URI, bytes, CID) outside of transaction.
 */
async function precomputeRecordData(
  input: RecordWriteInput,
  phases: WritePhases,
): Promise<PrecomputedRecordData> {
  const t0 = performance.now()
  const uri = AtUri.make(input.callerDid, input.collection, input.rkey)
  const recordBytes = encodeRecord(input.record)
  const recordCid = await computeCid(input.record)
  phases.prepareCommitBuild = performance.now() - t0
  return { uri, recordBytes, cid: recordCid }
}

/**
 * Validate create record input.
 * @param ctx - Application context
 * @param input - Input parameters for record creation
 * @param callerDid - DID of the caller
 *
 * @private
 */
async function validateCreateInput(
  ctx: AppContext,
  input: CreateRecordInput,
  callerDid: string,
): Promise<void> {
  const { repo, collection } = input

  // Must be creating record for self
  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot create record for another user')
  }

  ctx.writeRateLimiter.assertWriteAllowed(callerDid)

  // Validate collection is stratos namespace
  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
  }
  assertCollectionInHostedSpaceType(collection)
}

/**
 * Performs the create transaction with retry logic.
 */
async function performCreateTransaction(
  ctx: AppContext,
  input: RecordWriteInput,
  precomputed: PrecomputedRecordData,
  actorSign: ActorSignFn,
  sequenceTrace: SequenceTrace,
  phases: WritePhases,
): Promise<TransactionResult> {
  const t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(input.callerDid)
  try {
    await ensureStoreExists(ctx.actorStore, input.callerDid)

    const retry = await withConcurrencyRetry(async () => {
      return executeTransaction(
        ctx,
        input,
        precomputed,
        actorSign,
        sequenceTrace,
        phases,
      )
    }, ctx.logger)

    phases.transact = performance.now() - t0
    phases.retries = retry.retries
    return retry.result
  } finally {
    unlock()
  }
}

/**
 * Execute the create transaction.
 */
async function executeTransaction(
  ctx: AppContext,
  input: RecordWriteInput,
  { recordBytes, cid }: PrecomputedRecordData,
  actorSign: ActorSignFn,
  sequenceTrace: SequenceTrace,
  phases: WritePhases,
): Promise<TransactionResult> {
  const { callerDid, boundary, collection, rkey, record } = input
  // WARNING: Use `transact()` — not `readThenTransact()`. The manager calls
  // lockRoot() (FOR UPDATE) internally, so a separate read phase would double
  // the root query and lose the row lock, leading to failed writes under concurrency.
  const attemptT0 = performance.now()
  return ctx.actorStore.transact(callerDid, async (store) => {
    phases.connAcquire = performance.now() - attemptT0
    const manager = createRepoManager(
      ctx.logger,
      store,
      actorSign,
      sequenceTrace,
    )

    const repoWrites: RepoWrite[] = [
      { action: 'create', collection, rkey, record, cid, boundary },
    ]

    // Pass store.repo directly — it carries the LRU block cache. Passing
    // store.repo.db instead would bypass the cache and hit PG on every MST read.
    const writeResult = await manager.applyWrites(
      callerDid,
      repoWrites,
      store.repo,
      [{ cid, bytes: recordBytes }],
    )

    const uri = AtUri.make(callerDid, collection, rkey)
    const ti = performance.now()
    await store.record.indexRecordInBoundary(
      uri.toString(),
      cid,
      record,
      boundary,
      'create',
      writeResult.rev,
    )

    // Associate blobs with the record. Boundary residence lives on the
    // record row, which indexRecordInBoundary maintains.
    const blobs = StratosValidator.extractBlobs(record)
    for (const blobCidStr of blobs) {
      const blobCid = parseCid(blobCidStr)
      await store.blob.associateBlobWithRecord(blobCid, uri.toString())
    }

    phases.transactPersist = performance.now() - ti

    return {
      uri,
      cid,
      commit: {
        cid: parseCid(writeResult.commitCid).toString(),
        rev: writeResult.rev,
      },
    }
  })
}
