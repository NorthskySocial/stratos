import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { CID } from 'multiformats/cid'
import { TID } from '@atproto/common-web'
import {
  cidForLex,
  encode as cborEncode,
  type LexValue,
} from '@atproto/lex-cbor'
import { AtUri } from '@atproto/syntax'

import {
  assertStratosValidation,
  extractBoundaryDomains,
  StratosValidationError,
  buildCommit,
  type MstWriteOp,
} from '@northskysocial/stratos-core'
import { MissingBlockError } from '@atcute/mst'

import type { AppContext } from '../context.js'
import type { ActorTransactor } from '../actor-store-types.js'
import {
  signCommit,
  signAndPersistCommit,
  StratosBlockStoreReader,
} from '../features/index.js'
import { Did } from '@atproto/api'

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

/**
 * Record creation input
 */
export interface CreateRecordInput {
  repo: Did
  collection: string
  rkey?: string
  record: unknown
  validate?: boolean
  swapCommit?: string
  requestId?: string
}

/**
 * Record creation output
 */
export interface CreateRecordOutput {
  uri: string
  cid: string
  commit?: {
    cid: string
    rev: string
  }
  validationStatus?: string
}

async function assertCallerCanWriteDomains(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  record: unknown,
): Promise<void> {
  if (!collection.startsWith('zone.stratos.')) {
    return
  }

  const requestedDomains = extractBoundaryDomains(
    record as Record<string, unknown>,
  )
  if (requestedDomains.length === 0) {
    return
  }

  const callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
  const missingDomains = requestedDomains.filter(
    (domain) => !callerDomains.includes(domain),
  )

  if (missingDomains.length > 0) {
    const availableDomains =
      callerDomains.length > 0 ? callerDomains.join(', ') : '(none)'
    throw new InvalidRequestError(
      `You do not have access to boundary domain(s): ${missingDomains.join(', ')}. Your enrolled domains: ${availableDomains}`,
      'ForbiddenBoundary',
    )
  }
}

async function validateWritableRecord(
  ctx: AppContext,
  callerDid: string,
  collection: string,
  record: unknown,
): Promise<void> {
  const rec = record as Record<string, unknown>

  // Resolve parent boundaries when the record is a reply
  const parentBoundaries = await resolveParentBoundaries(ctx, rec)

  try {
    assertStratosValidation(rec, collection, ctx.cfg.stratos, parentBoundaries)
  } catch (err) {
    if (err instanceof StratosValidationError) {
      throw new InvalidRequestError(err.message, 'InvalidRecord')
    }
    throw err
  }

  await assertCallerCanWriteDomains(ctx, callerDid, collection, record)
}

async function resolveParentBoundaries(
  ctx: AppContext,
  record: Record<string, unknown>,
): Promise<string[] | undefined> {
  const reply = record.reply as { parent?: { uri?: string } } | undefined
  if (!reply?.parent?.uri) {
    return undefined
  }

  let parentUri: AtUri
  try {
    parentUri = new AtUri(reply.parent.uri)
  } catch {
    return undefined
  }

  return ctx.actorStore.read(parentUri.hostname, async (store) => {
    const parentRecord = await store.record.getRecord(parentUri, null)
    if (!parentRecord) {
      return undefined
    }
    return extractBoundaryDomains(parentRecord.value as Record<string, unknown>)
  })
}

function assertRootUnchanged(
  currentRootCid: string | null,
  expectedRootCid: string | null,
): void {
  if (currentRootCid !== expectedRootCid) {
    throw new InvalidRequestError(
      'Concurrent modification detected, please retry',
      'ConcurrentModification',
    )
  }
}

const MAX_CONCURRENCY_RETRIES = 4
const BASE_RETRY_DELAY_MS = 25

function isRetriableWriteError(err: unknown): boolean {
  if (
    (err instanceof InvalidRequestError &&
      (err as { customErrorName?: string }).customErrorName ===
        'ConcurrentModification') ||
    err instanceof MissingBlockError
  ) {
    return true
  }
  // pg lock_timeout exceeded (SQLSTATE 55P03 — lock_not_available)
  const code = (err as { code?: string })?.code
  return code === '55P03'
}

async function withConcurrencyRetry<T>(
  fn: (attempt: number) => Promise<T>,
  logger?: AppContext['logger'],
): Promise<{ result: T; retries: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn(attempt)
      return { result, retries: attempt }
    } catch (err) {
      if (!isRetriableWriteError(err) || attempt >= MAX_CONCURRENCY_RETRIES) {
        throw err
      }
      const jitter = Math.random() * BASE_RETRY_DELAY_MS
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + jitter
      logger?.info(
        { attempt: attempt + 1, delayMs: Math.round(delay) },
        'retrying after concurrent modification',
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Create a new record in the stratos store
 */
export async function createRecord(
  ctx: AppContext,
  input: CreateRecordInput,
  callerDid: string,
): Promise<CreateRecordOutput & { phases?: WritePhases }> {
  const phases: WritePhases = {}
  const { repo, collection, record, validate = true } = input
  const sequenceTrace: SequenceTrace = {
    requestId: input.requestId,
    queuedAtMs: Date.now(),
  }

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

  // Generate the record key if not provided
  const rkey = input.rkey ?? TID.nextStr()

  // Check if enrolled
  let t0 = performance.now()
  const isEnrolled = await ctx.enrollmentStore.isEnrolled(callerDid)
  phases.enrollment = performance.now() - t0
  if (!isEnrolled) {
    throw new InvalidRequestError(
      'User is not enrolled in this Stratos service',
      'NotEnrolled',
    )
  }

  const actorSigningKey = await ctx.getActorSigningKey(callerDid)

  // Validate the record if requested
  if (validate) {
    t0 = performance.now()
    await validateWritableRecord(ctx, callerDid, collection, record)
    phases.validation = performance.now() - t0
  }

  // Pre-compute CPU-bound work outside the transaction
  t0 = performance.now()
  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)
  const recordBytes = encodeRecord(record)
  const cid = await computeCid(record)
  phases.encode = performance.now() - t0

  const writes: MstWriteOp[] = [
    { action: 'create', collection, rkey, cid: cid.toString() },
  ]

  t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: {
    uri: AtUri
    cid: typeof cid
    cidStr: string
    commit: { cid: string; rev: string }
  }
  let retries: number
  try {
    // Ensure actor store exists (inside mutex to prevent creation race)
    const ta = performance.now()
    const exists = await ctx.actorStore.exists(callerDid)
    if (!exists) {
      await ctx.actorStore.create(callerDid)
    }
    phases.actorExists = performance.now() - ta

    const retry = await withConcurrencyRetry(async () => {
      const attemptT0 = performance.now()
      return ctx.actorStore.readThenTransact(
        callerDid,
        async (reader) => {
          phases.connAcquire = performance.now() - attemptT0

          let ts = performance.now()
          const rootDetails = await reader.repo.getRootDetailed()
          const rootCid = rootDetails?.cid.toString() ?? null
          phases.prepareCommitGetRoot = performance.now() - ts

          ts = performance.now()
          const storage = new StratosBlockStoreReader(reader.repo)
          const unsigned = await buildCommit(storage, rootCid, {
            did: callerDid,
            writes,
          })
          phases.prepareCommitBuild = performance.now() - ts

          return { unsigned, rootCid }
        },
        async (prepared, store) => {
          const transactT0 = performance.now()
          const currentRoot = await store.repo.lockRoot()
          assertRootUnchanged(
            currentRoot?.cid.toString() ?? null,
            prepared.rootCid,
          )
          phases.transactLockCheck = performance.now() - transactT0

          let ti = performance.now()
          const signed = await signCommit(actorSigningKey, prepared.unsigned, [
            { cid, bytes: recordBytes },
          ])
          phases.transactSign = performance.now() - ti

          ti = performance.now()
          const persistOps: Promise<void>[] = [
            store.repo.putBlocks(signed.allBlocks, prepared.unsigned.rev),
            store.repo.updateRoot(
              signed.commitCid,
              prepared.unsigned.rev,
              callerDid,
            ),
            store.record.indexRecord(
              uri,
              cid,
              record as Record<string, unknown>,
              'create',
              prepared.unsigned.rev,
            ),
          ]
          if (signed.removedCids.length > 0) {
            persistOps.push(store.repo.deleteBlocks(signed.removedCids))
          }
          await Promise.all(persistOps)
          phases.transactPersist = performance.now() - ti

          // Sequence inline (same connection)
          await sequenceChange(store, {
            action: 'create',
            uri: uriStr,
            cid: cid.toString(),
            record,
            commitCid: signed.commitCid.toString(),
            rev: signed.rev,
            trace: sequenceTrace,
          })

          return {
            uri,
            cid,
            cidStr: cid.toString(),
            commit: {
              cid: signed.commitCid.toString(),
              rev: signed.rev,
            },
          }
        },
      )
    }, ctx.logger)
    result = retry.result
    retries = retry.retries
  } finally {
    unlock()
  }
  phases.transact = performance.now() - t0
  phases.retries = retries

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  // Write stub to user's PDS (background, non-blocking)
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
    result.cid,
    createdAt,
  )

  return {
    uri: result.uri.toString(),
    cid: result.cid.toString(),
    commit: result.commit,
    phases,
  }
}

/**
 * Delete record input
 */
export interface DeleteRecordInput {
  repo: string
  collection: string
  rkey: string
  swapRecord?: string
  swapCommit?: string
  requestId?: string
}

/**
 * Delete a record from the stratos store
 */
export async function deleteRecord(
  ctx: AppContext,
  input: DeleteRecordInput,
  callerDid: string,
): Promise<{ commit?: { cid: string; rev: string }; phases?: WritePhases }> {
  const phases: WritePhases = {}
  const { repo, collection, rkey } = input
  const sequenceTrace: SequenceTrace = {
    requestId: input.requestId,
    queuedAtMs: Date.now(),
  }

  // Must be deleting own record
  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot delete record for another user')
  }

  ctx.writeRateLimiter.assertWriteAllowed(callerDid)

  // Validate collection
  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
  }

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)

  const actorSigningKey = await ctx.getActorSigningKey(callerDid)

  const t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: { commit: { cid: string; rev: string } }
  let retries: number
  try {
    const retry = await withConcurrencyRetry(async () => {
      const attemptT0 = performance.now()
      return ctx.actorStore.readThenTransact(
        callerDid,
        async (reader) => {
          phases.connAcquire = performance.now() - attemptT0

          let ts = performance.now()
          const rootDetails = await reader.repo.getRootDetailed()
          const rootCid = rootDetails?.cid.toString() ?? null
          phases.prepareCommitGetRoot = performance.now() - ts

          ts = performance.now()
          const storage = new StratosBlockStoreReader(reader.repo)
          const unsigned = await buildCommit(storage, rootCid, {
            did: callerDid,
            writes: [{ action: 'delete', collection, rkey, cid: null }],
          })
          phases.prepareCommitBuild = performance.now() - ts

          return { unsigned, rootCid }
        },
        async (prepared, store) => {
          const transactT0 = performance.now()
          const currentRoot = await store.repo.lockRoot()
          assertRootUnchanged(
            currentRoot?.cid.toString() ?? null,
            prepared.rootCid,
          )
          phases.transactLockCheck = performance.now() - transactT0

          const existing = await store.record.getRecord(uri, null)
          if (!existing) {
            throw new InvalidRequestError('Record not found', 'RecordNotFound')
          }

          let ti = performance.now()
          const signed = await signCommit(actorSigningKey, prepared.unsigned)
          phases.transactSign = performance.now() - ti

          ti = performance.now()
          const persistOps: Promise<void>[] = [
            store.record.deleteRecord(uri),
            store.repo.putBlocks(signed.allBlocks, prepared.unsigned.rev),
            store.repo.updateRoot(
              signed.commitCid,
              prepared.unsigned.rev,
              callerDid,
            ),
          ]
          if (signed.removedCids.length > 0) {
            persistOps.push(store.repo.deleteBlocks(signed.removedCids))
          }
          await Promise.all(persistOps)
          phases.transactPersist = performance.now() - ti

          // Sequence inline (same connection)
          await sequenceChange(store, {
            action: 'delete',
            uri: uriStr,
            commitCid: signed.commitCid.toString(),
            rev: signed.rev,
            trace: sequenceTrace,
          })

          return {
            commit: {
              cid: signed.commitCid.toString(),
              rev: signed.rev,
            },
          }
        },
      )
    }, ctx.logger)
    result = retry.result
    retries = retry.retries
  } finally {
    unlock()
  }
  phases.transact = performance.now() - t0
  phases.retries = retries

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  // Delete stub from user's PDS (background, non-blocking)
  ctx.stubQueue.enqueueDelete(callerDid, collection, rkey)

  return { ...result, phases }
}

export interface UpdateRecordInput {
  repo: Did
  collection: string
  rkey: string
  record: unknown
  validate?: boolean
  requestId?: string
}

interface SequenceTrace {
  requestId?: string
  queuedAtMs: number
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

export async function updateRecord(
  ctx: AppContext,
  input: UpdateRecordInput,
  callerDid: string,
): Promise<UpdateRecordOutput & { phases?: WritePhases }> {
  const phases: WritePhases = {}
  const { repo, collection, rkey, record, validate = true } = input
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
  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)
  const recordBytes = encodeRecord(record)
  const cid = await computeCid(record)
  phases.encode = performance.now() - t0

  const actorSigningKey = await ctx.getActorSigningKey(callerDid)

  t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: {
    uri: AtUri
    cid: typeof cid
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

          let ts = performance.now()
          const rootDetails = await reader.repo.getRootDetailed()
          const rootCid = rootDetails?.cid.toString() ?? null
          phases.prepareCommitGetRoot = performance.now() - ts

          ts = performance.now()
          const storage = new StratosBlockStoreReader(reader.repo)
          const unsigned = await buildCommit(storage, rootCid, {
            did: callerDid,
            writes: [
              { action: 'update', collection, rkey, cid: cid.toString() },
            ],
          })
          phases.prepareCommitBuild = performance.now() - ts

          return { unsigned, rootCid }
        },
        async (prepared, store) => {
          const transactT0 = performance.now()
          const currentRoot = await store.repo.lockRoot()
          assertRootUnchanged(
            currentRoot?.cid.toString() ?? null,
            prepared.rootCid,
          )
          phases.transactLockCheck = performance.now() - transactT0

          const existing = await store.record.getRecord(uri, null)
          if (!existing) {
            throw new InvalidRequestError('Record not found', 'RecordNotFound')
          }

          let ti = performance.now()
          const signed = await signCommit(actorSigningKey, prepared.unsigned, [
            { cid, bytes: recordBytes },
          ])
          phases.transactSign = performance.now() - ti

          ti = performance.now()
          const persistOps: Promise<void>[] = [
            store.repo.putBlocks(signed.allBlocks, prepared.unsigned.rev),
            store.repo.updateRoot(
              signed.commitCid,
              prepared.unsigned.rev,
              callerDid,
            ),
            store.record.indexRecord(
              uri,
              cid,
              record as Record<string, unknown>,
              'update',
              prepared.unsigned.rev,
            ),
          ]
          if (signed.removedCids.length > 0) {
            persistOps.push(store.repo.deleteBlocks(signed.removedCids))
          }
          await Promise.all(persistOps)
          phases.transactPersist = performance.now() - ti

          // Sequence inline (same connection)
          await sequenceChange(store, {
            action: 'update',
            uri: uriStr,
            cid: cid.toString(),
            record,
            commitCid: signed.commitCid.toString(),
            rev: signed.rev,
            trace: sequenceTrace,
          })

          return {
            uri,
            cid,
            cidStr: cid.toString(),
            commit: {
              cid: signed.commitCid.toString(),
              rev: signed.rev,
            },
          }
        },
      )
    }, ctx.logger)
    result = retry.result
    retries = retry.retries
  } finally {
    unlock()
  }
  phases.transact = performance.now() - t0
  phases.retries = retries

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  // Update stub on PDS (background, non-blocking)
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
    result.cid,
    createdAt,
  )

  return {
    uri: result.uri.toString(),
    cid: result.cid.toString(),
    commit: result.commit,
    phases,
  }
}

/**
 * Get record input
 */
export interface GetRecordInput {
  repo: string
  collection: string
  rkey: string
  cid?: string
}

/**
 * Get a record from the stratos store
 */
export async function getRecord(
  ctx: AppContext,
  input: GetRecordInput,
  callerDid?: string,
  callerDomains?: string[],
): Promise<{
  uri: string
  cid?: string
  value: unknown
}> {
  const { repo, collection, rkey, cid } = input
  const uriStr = `at://${repo}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)

  // Check if actor store exists
  const exists = await ctx.actorStore.exists(repo)
  if (!exists) {
    throw new InvalidRequestError('Record not found', 'RecordNotFound')
  }

  return await ctx.actorStore.read(repo, async (store) => {
    const record = await store.record.getRecord(uri, cid ?? null)
    if (!record) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }

    // Check domain boundary if caller is not the owner
    if (callerDid !== repo) {
      const boundary = extractBoundaryDomains(
        record.value as Record<string, unknown>,
      )
      if (boundary.length > 0 && callerDomains) {
        const allowed = boundary.some((domain) =>
          callerDomains.includes(domain),
        )
        if (!allowed) {
          throw new InvalidRequestError('Record not found', 'RecordNotFound')
        }
      }
    }

    return {
      uri: uriStr,
      cid: record.cid,
      value: record.value,
    }
  })
}

/**
 * List records input
 */
export interface ListRecordsInput {
  repo: string
  collection: string
  limit?: number
  cursor?: string
  reverse?: boolean
}

/**
 * List records from the stratos store
 */
export async function listRecords(
  ctx: AppContext,
  input: ListRecordsInput,
  callerDid?: string,
  callerDomains?: string[],
): Promise<{
  records: Array<{ uri: string; cid: string; value: unknown }>
  cursor?: string
}> {
  const { repo, collection, limit = 50, cursor, reverse = false } = input

  // Check if actor store exists
  const exists = await ctx.actorStore.exists(repo)
  if (!exists) {
    return { records: [] }
  }

  return await ctx.actorStore.read(repo, async (store) => {
    const records = await store.record.listRecordsForCollection({
      collection,
      limit,
      cursor,
      reverse,
    })

    // Filter by domain boundary if needed
    const filtered = records.filter(
      (record: {
        uri: string
        cid: string
        value: Record<string, unknown>
      }) => {
        if (callerDid === repo) {
          return true // Owner sees everything
        }

        const boundary = extractBoundaryDomains(record.value)
        if (boundary.length === 0 || !callerDomains) {
          return true // No boundary restriction
        }

        return boundary.some((domain) => callerDomains.includes(domain))
      },
    )

    const lastRecord = filtered[filtered.length - 1]
    const nextCursor = lastRecord
      ? `${lastRecord.uri.split('/').pop()}`
      : undefined

    return {
      records: filtered.map(
        (r: { uri: string; cid: string; value: Record<string, unknown> }) => ({
          uri: r.uri,
          cid: r.cid,
          value: r.value,
        }),
      ),
      cursor: nextCursor,
    }
  })
}

// Helper functions

/**
 * Apply multiple write operations in a single MST commit
 */
export interface BatchWriteOp {
  action: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: unknown
}

export interface BatchWriteResult {
  results: Array<{
    uri?: string
    cid?: string
  }>
  commit: {
    cid: string
    rev: string
  }
}

export async function applyWritesBatch(
  ctx: AppContext,
  callerDid: string,
  ops: BatchWriteOp[],
  requestId?: string,
): Promise<BatchWriteResult> {
  const sequenceTrace: SequenceTrace = {
    requestId,
    queuedAtMs: Date.now(),
  }

  ctx.writeRateLimiter.assertWriteAllowed(callerDid, ops.length)

  // Pre-compute CPU-bound work outside the transaction
  const precomputed = await Promise.all(
    ops.map(async (op) => {
      const rkey = op.action === 'create' ? op.rkey || TID.nextStr() : op.rkey
      const uriStr = `at://${callerDid}/${op.collection}/${rkey}`
      const uri = new AtUri(uriStr)

      if (op.action === 'delete') {
        return { op, rkey, uriStr, uri, action: 'delete' as const }
      }

      await validateWritableRecord(ctx, callerDid, op.collection, op.record)
      const recordBytes = encodeRecord(op.record)
      const cid = await computeCid(op.record)
      const tempRev = TID.nextStr()
      return {
        op,
        rkey,
        uriStr,
        uri,
        action: op.action,
        recordBytes,
        cid,
        tempRev,
      }
    }),
  )

  // Build MST ops from precomputed data
  const mstOps: MstWriteOp[] = precomputed.map((pre) => ({
    action: pre.action,
    collection: pre.op.collection,
    rkey: pre.rkey,
    cid: pre.action === 'delete' ? null : pre.cid!.toString(),
  }))

  // Build and commit with concurrency retry
  const actorSigningKey = await ctx.getActorSigningKey(callerDid)
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: {
    results: Array<{ uri?: string; cid?: string }>
    commit: { cid: string; rev: string }
  }
  try {
    // Ensure actor store exists (inside mutex to prevent creation race)
    const exists = await ctx.actorStore.exists(callerDid)
    if (!exists) {
      await ctx.actorStore.create(callerDid)
    }

    const retry = await withConcurrencyRetry(async () => {
      return ctx.actorStore.readThenTransact(
        callerDid,
        async (reader) => {
          const rootDetails = await reader.repo.getRootDetailed()
          const rootCid = rootDetails?.cid.toString() ?? null
          const storage = new StratosBlockStoreReader(reader.repo)
          const unsigned = await buildCommit(storage, rootCid, {
            did: callerDid,
            writes: mstOps,
          })
          return { rootCid, unsigned }
        },
        async ({ rootCid, unsigned }, store) => {
          const currentRoot = await store.repo.lockRoot()
          assertRootUnchanged(currentRoot?.cid.toString() ?? null, rootCid)

          for (const pre of precomputed) {
            if (pre.action === 'delete') {
              const existing = await store.record.getRecord(pre.uri, null)
              if (!existing) {
                throw new InvalidRequestError(
                  'Record not found',
                  'RecordNotFound',
                )
              }
            } else {
              await store.repo.putBlock(pre.cid, pre.recordBytes, pre.tempRev)
            }
          }

          const commitResult = await signAndPersistCommit(
            store.repo,
            actorSigningKey,
            unsigned,
          )

          const results: Array<{ uri?: string; cid?: string }> = []
          for (const pre of precomputed) {
            if (pre.action === 'delete') {
              await store.record.deleteRecord(pre.uri)
              results.push({})
            } else {
              await store.record.indexRecord(
                pre.uri,
                pre.cid!,
                pre.op.record as Record<string, unknown>,
                pre.action,
                commitResult.rev,
              )
              results.push({ uri: pre.uriStr, cid: pre.cid!.toString() })
            }
          }

          // Sequence all changes inline (same connection)
          for (const pre of precomputed) {
            await sequenceChange(store, {
              action: pre.action,
              uri: pre.uriStr,
              cid: pre.action !== 'delete' ? pre.cid.toString() : undefined,
              record:
                pre.action !== 'delete'
                  ? (pre.op.record as unknown)
                  : undefined,
              commitCid: commitResult.commitCid.toString(),
              rev: commitResult.rev,
              trace: sequenceTrace,
            })
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

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  return result
}

function encodeRecord(record: unknown): Uint8Array {
  // Use CBOR encoding for records
  // Cast to LexValue since we validate the record before calling this
  return cborEncode(record as LexValue)
}

async function computeCid(record: unknown): Promise<CID> {
  // Compute CID using SHA-256 and DAG-CBOR codec
  // Cast to LexValue since we validate the record before calling this
  const cid = await cidForLex(record as LexValue)
  return CID.parse(cid.toString())
}

async function sequenceChange(
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
): Promise<void> {
  // Sequence the change for subscriptions
  const event: LexValue = {
    action: op.action,
    path: new AtUri(op.uri).pathname,
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
