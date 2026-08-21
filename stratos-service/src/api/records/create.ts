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
import { validateWritableRecord, withConcurrencyRetry } from './validation.js'
import { type SequenceTrace, type WritePhases } from './types.js'
import { type Cid as CID } from '@atproto/lex-data'
import {
  createRepoManager,
  ensureActorStoreExists as ensureStoreExists,
} from './util.js'

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
  const { collection, record, validate = true } = input
  const sequenceTrace: SequenceTrace = {
    requestId: input.requestId,
    queuedAtMs: Date.now(),
  }

  await validateCreateInput(ctx, input, callerDid)

  // Check if enrolled
  let performanceTimer = performance.now()
  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  phases.enrollment = performance.now() - performanceTimer
  if (!enrollment || !enrollment.active) {
    throw new InvalidRequestError(
      'User is not enrolled in this Stratos service',
      'NotEnrolled',
    )
  }
  // Service enrollments are read-only: they may subscribe and hydrate within
  // their boundaries but must not create records. Classification uses the
  // explicit `isService` flag, never `pdsEndpoint` emptiness.
  if (enrollment.isService) {
    throw new InvalidRequestError(
      'Service identities cannot create records',
      'ServiceWriteForbidden',
    )
  }

  const actorSign = await ctx.actorSigner.getSignFn(callerDid)

  // Validate the record if requested
  if (validate) {
    performanceTimer = performance.now()
    await validateWritableRecord(ctx, callerDid, collection, record)
    phases.validation = performance.now() - performanceTimer
  }

  const precomputed = await precomputeRecordData(
    callerDid,
    collection,
    record,
    input.rkey,
    phases,
  )

  const result = await performCreateTransaction(
    ctx,
    callerDid,
    collection,
    input.rkey ?? precomputed.uri.rkey,
    record,
    precomputed.recordBytes,
    precomputed.cid,
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
 *
 * @param callerDid - DID of the caller
 * @param collection - Collection NSID
 * @param record - Record data
 * @param inputRkey - Optional record key
 * @param phases - Write phases for tracking performance
 * @returns Precomputed record data
 */
async function precomputeRecordData(
  callerDid: string,
  collection: string,
  record: unknown,
  inputRkey: string | undefined,
  phases: WritePhases,
): Promise<PrecomputedRecordData> {
  const t0 = performance.now()
  const rkey = inputRkey ?? TID.nextStr()
  const uri = AtUri.make(callerDid, collection, rkey)
  const recordBytes = encodeRecord(record as Record<string, unknown>)
  const recordCid = await computeCid(record as Record<string, unknown>)
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
}

/**
 * Performs the create transaction with retry logic.
 * @param ctx - Application Context
 * @param callerDid - DID of the caller
 * @param collection - Collection name
 * @param rkey - Record key
 * @param record - Record data
 * @param recordBytes - Record bytes
 * @param cid - Content ID
 * @param actorSign - Bound actor signing function
 * @param sequenceTrace - Sequence trace
 * @param phases - Write phases
 * @returns Result of the create transaction
 */
async function performCreateTransaction(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  rkey: string,
  record: unknown,
  recordBytes: Uint8Array,
  cid: CID,
  actorSign: ActorSignFn,
  sequenceTrace: SequenceTrace,
  phases: WritePhases,
): Promise<TransactionResult> {
  const t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  try {
    await ensureStoreExists(ctx.actorStore, callerDid)

    const retry = await withConcurrencyRetry(async () => {
      return executeTransaction(
        ctx,
        callerDid,
        collection,
        rkey,
        record,
        recordBytes,
        cid,
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
 * @param ctx - The application context
 * @param callerDid - DID of the caller
 * @param collection - Collection name
 * @param rkey - Record key
 * @param record - Record data
 * @param recordBytes - Record bytes
 * @param cid - CID of the record
 * @param actorSign - Bound signing function for the actor
 * @param sequenceTrace - Sequence trace for the operation
 * @param phases - Write phases for tracking performance
 * @returns Result of the create transaction
 */
async function executeTransaction(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  rkey: string,
  record: unknown,
  recordBytes: Uint8Array,
  cid: CID,
  actorSign: ActorSignFn,
  sequenceTrace: SequenceTrace,
  phases: WritePhases,
): Promise<TransactionResult> {
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
      { action: 'create', collection, rkey, record, cid },
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
    await store.record.indexRecord(
      uri.toString(),
      cid,
      record as Record<string, unknown>,
      'create',
      writeResult.rev,
    )

    // Associate blobs with the record. Boundary residence lives on the
    // record row, which indexRecord maintains.
    const blobs = StratosValidator.extractBlobs(record)
    const boundaries = StratosValidator.extractBoundaryDomains(
      record as Record<string, unknown>,
    )
    for (const blobCidStr of blobs) {
      const blobCid = parseCid(blobCidStr)
      await store.blob.associateBlobWithRecord(blobCid, uri.toString())
      // Update Bloom filter for fast rejection
      if (ctx.bloomManager) {
        await ctx.bloomManager.updateBloom(blobCid, boundaries)
      }
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
