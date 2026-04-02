import { type Cid as CID } from '@atproto/lex-data'
import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import {
  computeCid,
  encodeRecord,
  parseCid,
  RepoWrite,
} from '@northskysocial/stratos-core'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { AppContext } from '../../context-types.js'
import { validateWritableRecord, withConcurrencyRetry } from './validation.js'
import { createRepoManager } from './util.js'
import { type SequenceTrace, type WritePhases } from './types.js'
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
  const { repo, collection, rkey, record } = input
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
      return ctx.actorStore.readThenTransact(
        callerDid,
        async (reader) => {
          phases.connAcquire = performance.now() - attemptT0
          const root = await reader.repo.getRoot()
          return {
            rootCid: root ? parseCid(root).toString() : null,
          }
        },
        async (_prepared, store) => {
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
        },
      )
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

  enqueueStubUpdate(
    ctx,
    callerDid,
    collection,
    rkey,
    record,
    updateResult.cidStr,
  )

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
  const actorSigningKey = await ctx.getActorSigningKey(callerDid)
  const manager = createRepoManager(
    ctx.logger,
    store,
    actorSigningKey,
    sequenceTrace,
  )

  const repoWrites: RepoWrite[] = [
    { action: 'update', collection, rkey, record, cid },
  ]

  const writeResult = await manager.applyWrites(callerDid, repoWrites, [
    { cid, bytes: recordBytes },
  ])

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUriSyntax(uriStr)
  await store.record.indexRecord(
    uri,
    cid,
    record as Record<string, unknown>,
    'update',
    writeResult.rev,
  )

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
 * Enqueue a stub write to the user's PDS in the background.'
 * @param ctx - The application context
 * @param callerDid - The DID of the caller
 * @param collection - The collection name
 * @param rkey - The record key
 * @param record - The updated record object
 * @param cidStr - The CID string of the updated record
 */
function enqueueStubUpdate(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  rkey: string,
  record: unknown,
  cidStr: string,
) {
  const recordObj = record as Record<string, unknown>
  const createdAt =
    typeof recordObj.createdAt === 'string'
      ? recordObj.createdAt
      : new Date().toISOString()
  const recordType =
    typeof recordObj.$type === 'string' ? recordObj.$type : collection

  ctx.stubQueue.enqueueWrite(
    callerDid,
    collection,
    rkey,
    recordType,
    parseCid(cidStr),
    createdAt,
  )
}
