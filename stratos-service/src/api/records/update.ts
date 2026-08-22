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
import { validateWritableRecord, withConcurrencyRetry } from './validation.js'
import { createRepoManager } from './util.js'
import {
  sequenceChange,
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
 * @param ctx - The application context
 * @param input - The update record input
 * @param callerDid - The DID of the caller
 * @param phases - The write phases object
 * @returns The URI, record bytes, and CID
 * @throws InvalidRequestError if the repo does not exist
 */
async function prepareUpdatePhases(
  ctx: AppContext,
  input: UpdateRecordInput,
  callerDid: string,
  phases: WritePhases,
) {
  const { collection, record, validate = true } = input
  let t0 = performance.now()
  const exists = await ctx.actorStore.exists(callerDid)
  if (!exists) {
    throw new InvalidRequestError('Repo not found', 'RepoNotFound')
  }
  phases.actorExists = performance.now() - t0

  if (validate) {
    t0 = performance.now()
    await validateWritableRecord(ctx, callerDid, collection, record)
    phases.validation = performance.now() - t0
  }

  // Pre-compute CPU-bound work outside the transaction
  t0 = performance.now()
  const rkey = input.rkey
  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUriSyntax(uriStr)
  const recordBytes = encodeRecord(record)
  const cid = await computeCid(record)
  phases.encode = performance.now() - t0

  return { uri, recordBytes, cid }
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

  const { recordBytes, cid } = await prepareUpdatePhases(
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
          callerDid,
          input,
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
 * @param ctx - The application context
 * @param store - The actor transactor store
 * @param callerDid - The DID of the caller
 * @param input - The update record input
 * @param recordBytes - The bytes of the updated record
 * @param cid - The CID of the updated record
 * @param sequenceTrace - The sequence trace for the update
 * @returns The updated record details
 */
async function performUpdate(
  ctx: AppContext,
  store: ActorTransactor,
  callerDid: string,
  input: UpdateRecordInput,
  recordBytes: Uint8Array,
  cid: CID,
  sequenceTrace: SequenceTrace,
) {
  const { collection, rkey, record } = input
  const actorSign = await ctx.actorSigner.getSignFn(callerDid)
  const manager = createRepoManager(ctx.logger, store, actorSign, sequenceTrace)

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUriSyntax(uriStr)

  // Capture the pre-update domain so a domain change (a "move") can emit a
  // removal scoped to the OLD domain. Read before applyWrites overwrites it.
  const previousDomains = await readRecordDomains(store, uri)

  const repoWrites: RepoWrite[] = [
    { action: 'update', collection, rkey, record, cid },
  ]

  const writeResult = await manager.applyWrites(
    callerDid,
    repoWrites,
    store.repo,
    [{ cid, bytes: recordBytes }],
  )

  await sequenceMoveRemovals(store, {
    uriStr,
    record,
    previousDomains,
    commitCid: writeResult.commitCid.toString(),
    rev: writeResult.rev,
    sequenceTrace,
  })

  await store.record.indexRecord(
    uri,
    cid,
    record as Record<string, unknown>,
    'update',
    writeResult.rev,
  )

  // Replace blob associations so removed blobs drop out of the index.
  // Boundary residence lives on the record row, which indexRecord maintains.
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
 * Read the domains currently stored for a record, prior to an update. Returns
 * an empty array when the record does not yet exist.
 *
 * @param store - The actor transactor store.
 * @param uri - The record URI.
 * @returns The record's current boundary domains.
 */
async function readRecordDomains(
  store: ActorTransactor,
  uri: AtUriSyntax,
): Promise<string[]> {
  const existing = await store.record.getRecord(uri, null)
  if (!existing) return []
  return StratosValidator.extractBoundaryDomains(existing.value)
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
 *
 * @param store - The actor transactor store.
 * @param args - Move context: URI, new record, prior domains, commit/rev, trace.
 */
async function sequenceMoveRemovals(
  store: ActorTransactor,
  args: {
    uriStr: string
    record: unknown
    previousDomains: string[]
    commitCid: string
    rev: string
    sequenceTrace: SequenceTrace
  },
): Promise<void> {
  const { uriStr, record, previousDomains, commitCid, rev, sequenceTrace } =
    args
  if (previousDomains.length === 0) return

  const newDomains = new Set(
    StratosValidator.extractBoundaryDomains(record as Record<string, unknown>),
  )
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
