import { type Cid as CID } from '@atproto/lex-data'
import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import {
  computeCid,
  encodeRecord,
  parseCid,
  RepoWrite,
  StratosValidator,
} from '@northskysocial/stratos-core'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { AppContext } from '../../context-types.js'
import {
  authorizeRecordBoundary,
  assertCollectionInHostedSpaceType,
  validateRecordContent,
  withConcurrencyRetry,
} from './validation.js'
import { createRepoManager } from './util.js'
import { assertStratosCustody, assertWritableEnrollment } from './custody.js'
import {
  sequenceChange,
  type RecordWriteInput,
  type SequenceTrace,
  type WritePhases,
} from './types.js'
import type { ActorTransactor } from '../../actor-store-types.js'

export interface UpdateRecordInput {
  repo: string
  collection: string
  rkey: string
  record: unknown
  validate?: boolean
  requestId?: string
}

export interface UpdateRecordOutput {
  uri: string
  cid: string
  commit?: {
    cid: string
    rev: string
  }
  validationStatus?: string
}

/**
 * Prepare phases for update transaction.
 * @throws InvalidRequestError if the repo does not exist
 */
async function prepareUpdatePhases(
  ctx: AppContext,
  input: UpdateRecordInput,
  callerDid: string,
  phases: WritePhases,
) {
  const { collection, record } = input
  let t0 = performance.now()
  const exists = await ctx.actorStore.exists(callerDid)
  if (!exists) {
    throw new InvalidRequestError('Repo not found', 'RepoNotFound')
  }
  phases.actorExists = performance.now() - t0

  t0 = performance.now()
  // `validate: false` cannot loosen any Stratos rule on this path: lexicon
  // errors are never fatal, and the business rules run on every write.
  await validateRecordContent(ctx, collection, record)
  const boundary = await authorizeRecordBoundary(
    ctx,
    callerDid,
    collection,
    record,
  )
  phases.validation = performance.now() - t0

  // Pre-compute CPU-bound work outside the transaction
  t0 = performance.now()
  const rkey = input.rkey
  const recordBytes = encodeRecord(record)
  const cid = await computeCid(record)
  phases.encode = performance.now() - t0

  const writeInput: RecordWriteInput = {
    callerDid,
    boundary,
    collection,
    rkey,
    record: record as Record<string, unknown>,
  }

  return { writeInput, recordBytes, cid }
}

/**
 * Update a record in the Stratos database
 * @param ctx - Application context
 * @param input - Update record input parameters
 * @param callerDid - DID of the caller
 * @returns Updated record details
 * @throws AuthRequiredError if the caller is not the owner of the record
 * @throws InvalidRequestError if the collection is not a Stratos collection
 */
export async function updateRecord(
  ctx: AppContext,
  input: UpdateRecordInput,
  callerDid: string,
): Promise<UpdateRecordOutput & { phases?: WritePhases }> {
  const phases: WritePhases = {}
  const { repo, collection } = input
  const sequenceTrace: SequenceTrace = {
    requestId: input.requestId,
    queuedAtMs: Date.now(),
  }

  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot update record for another user')
  }

  ctx.writeRateLimiter.assertWriteAllowed(callerDid)

  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
  }
  assertCollectionInHostedSpaceType(collection)

  const enrollment = await ctx.enrollmentStore.getEnrollment(callerDid)
  assertWritableEnrollment(enrollment)
  assertStratosCustody(enrollment)

  const { writeInput, recordBytes, cid } = await prepareUpdatePhases(
    ctx,
    input,
    callerDid,
    phases,
  )

  const t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let updateResult: {
    uri: string
    cidStr: string
    commit: { cid: string; rev: string }
  }
  let retries: number
  try {
    const retry = await withConcurrencyRetry(async () => {
      const attemptT0 = performance.now()
      // See create.ts for why we use transact() and pass store.repo directly.
      return ctx.actorStore.transact(callerDid, async (store) => {
        phases.connAcquire = performance.now() - attemptT0
        const result = await performUpdate(
          ctx,
          store,
          writeInput,
          recordBytes,
          cid,
          sequenceTrace,
        )
        return { ...result, uri: result.uri.toString() }
      })
    }, ctx.logger)
    updateResult = retry.result
    retries = retry.retries
  } finally {
    unlock()
  }
  phases.transact = performance.now() - t0
  phases.retries = retries

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  return {
    uri: updateResult.uri,
    cid: updateResult.cidStr,
    commit: updateResult.commit,
    phases,
  }
}

/**
 * Perform the update operation on the record.
 */
async function performUpdate(
  ctx: AppContext,
  store: ActorTransactor,
  input: RecordWriteInput,
  recordBytes: Uint8Array,
  cid: CID,
  sequenceTrace: SequenceTrace,
) {
  const { callerDid, collection, rkey, record } = input
  const actorSign = await ctx.actorSigner.getSignFn(callerDid)
  const manager = createRepoManager(ctx.logger, store, actorSign, sequenceTrace)

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUriSyntax(uriStr)

  // Capture the pre-update domain so a domain change (a "move") can emit a
  // removal scoped to the OLD domain. Read before applyWrites overwrites it.
  const previousDomains = await store.record.getRecordBoundaries(uri)

  const repoWrites: RepoWrite[] = [
    {
      action: 'update',
      collection,
      rkey,
      record,
      cid,
      boundary: input.boundary,
    },
  ]

  const writeResult = await manager.applyWrites(
    callerDid,
    repoWrites,
    store.repo,
    [{ cid, bytes: recordBytes }],
  )

  await sequenceMoveRemovals(store, {
    uriStr,
    newBoundary: input.boundary,
    previousDomains,
    commitCid: writeResult.commitCid.toString(),
    rev: writeResult.rev,
    sequenceTrace,
  })

  await store.record.indexRecordInBoundary(
    uri,
    cid,
    record,
    input.boundary,
    'update',
    writeResult.rev,
  )

  // Replace blob associations so removed blobs drop out of the index.
  // Boundary residence lives on the record row, which indexRecordInBoundary maintains.
  await store.blob.removeRecordBlobAssociations(uri.toString())
  const blobs = StratosValidator.extractBlobs(record)
  for (const blobCidStr of blobs) {
    const blobCid = parseCid(blobCidStr)
    await store.blob.associateBlobWithRecord(blobCid, uri.toString())
  }

  return {
    uri: uri.toString(),
    cid,
    cidStr: parseCid(cid).toString(),
    commit: {
      cid: parseCid(writeResult.commitCid).toString(),
      rev: writeResult.rev,
    },
  }
}

/**
 * Emit a boundary-carrying removal event for every domain the record has LEFT
 * (a "move"). A plain delete carries no boundary and is dropped for everyone by
 * `eventInScope`, so a subscriber scoped only to the old domain would never see
 * the record leave. Instead we sequence a scoped `delete` op whose payload
 * carries the OLD domain as an explicit op-level `boundary` (never the record
 * body), sharing the update's `rev`. Result on both sync channels:
 * - old-domain-only subscriber: observes the removal (delete op),
 * - new-domain subscriber: observes the update (carries the new boundary),
 * - third-party subscriber: observes nothing.
 */
async function sequenceMoveRemovals(
  store: ActorTransactor,
  args: {
    uriStr: string
    newBoundary: string
    previousDomains: string[]
    commitCid: string
    rev: string
    sequenceTrace: SequenceTrace
  },
): Promise<void> {
  const {
    uriStr,
    newBoundary,
    previousDomains,
    commitCid,
    rev,
    sequenceTrace,
  } = args
  if (previousDomains.length === 0) return

  const newDomains = new Set([newBoundary])
  const removedDomains = previousDomains.filter((d) => !newDomains.has(d))
  if (removedDomains.length === 0) return

  await sequenceChange(store, {
    action: 'delete',
    uri: uriStr,
    boundary: { values: removedDomains.map((value) => ({ value })) },
    // The record still exists in its new domain(s): a subscriber enrolled in
    // both the old and new domain must observe the UPDATE, not this removal.
    excludeBoundary: { values: [...newDomains].map((value) => ({ value })) },
    commitCid,
    rev,
    trace: sequenceTrace,
  })
}
