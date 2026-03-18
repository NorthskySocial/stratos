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
  buildCommit,
  extractBoundaryDomains,
  StratosValidationError,
  type MstWriteOp,
  type UnsignedCommitData,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../context.js'
import type { ActorTransactor } from '../actor-store-types.js'
import {
  StratosBlockStoreReader,
  signAndPersistCommit,
} from '../features/index.js'
import { Did } from '@atproto/api'

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
  try {
    assertStratosValidation(
      record as Record<string, unknown>,
      collection,
      ctx.cfg.stratos,
    )
  } catch (err) {
    if (err instanceof StratosValidationError) {
      throw new InvalidRequestError(err.message, 'InvalidRecord')
    }
    throw err
  }

  await assertCallerCanWriteDomains(ctx, callerDid, collection, record)
}

interface PreparedCommit {
  unsigned: UnsignedCommitData
  rootCid: string | null
}

async function prepareCommit(
  ctx: AppContext,
  did: string,
  writes: MstWriteOp[],
): Promise<PreparedCommit> {
  return ctx.actorStore.read(did, async (reader) => {
    const adapter = new StratosBlockStoreReader(reader.repo)
    const rootDetails = await reader.repo.getRootDetailed()
    if (rootDetails) {
      await reader.repo.preloadRootSpine(rootDetails.cid)
    }
    const unsigned = await buildCommit(
      adapter,
      rootDetails?.cid.toString() ?? null,
      { did, writes },
    )
    return { unsigned, rootCid: rootDetails?.cid.toString() ?? null }
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

/**
 * Create a new record in the stratos store
 */
export async function createRecord(
  ctx: AppContext,
  input: CreateRecordInput,
  callerDid: string,
): Promise<CreateRecordOutput> {
  const { repo, collection, record, validate = true } = input

  // Must be creating record for self
  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot create record for another user')
  }

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
  const isEnrolled = await ctx.enrollmentStore.isEnrolled(callerDid)
  if (!isEnrolled) {
    throw new InvalidRequestError(
      'User is not enrolled in this Stratos service',
      'NotEnrolled',
    )
  }

  // Check if actor store exists, create if not
  const exists = await ctx.actorStore.exists(callerDid)
  if (!exists) {
    await ctx.actorStore.create(callerDid)
  }

  // Validate the record if requested
  if (validate) {
    await validateWritableRecord(ctx, callerDid, collection, record)
  }

  // Pre-compute CPU-bound work outside the transaction
  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)
  const recordBytes = encodeRecord(record)
  const cid = await computeCid(record)
  const rev = TID.nextStr()

  // Build MST commit outside the write transaction to reduce connection hold time
  const prepared = await prepareCommit(ctx, callerDid, [
    { action: 'create', collection, rkey, cid: cid.toString() },
  ])

  // Perform the write
  const result = await ctx.actorStore.transact(callerDid, async (store) => {
    // Optimistic lock: verify repo root hasn't changed since we read the MST
    const currentRoot = await store.repo.getRootDetailed()
    assertRootUnchanged(
      currentRoot?.cid.toString() ?? null,
      prepared.rootCid,
    )

    // Store the record block
    await store.repo.putBlock(cid, recordBytes, rev)

    const commitResult = await signAndPersistCommit(
      store.repo,
      ctx.signingKey,
      prepared.unsigned,
    )

    // Index the record
    await store.record.indexRecord(
      uri,
      cid,
      record as Record<string, unknown>,
      'create',
      commitResult.rev,
    )

    return {
      uri,
      cid,
      cidStr: cid.toString(),
      commit: {
        cid: commitResult.commitCid.toString(),
        rev: commitResult.rev,
      },
    }
  })

  // Sequence the change (deferred, non-blocking)
  deferSequenceChange(ctx, callerDid, {
    action: 'create',
    uri: uriStr,
    cid: cid.toString(),
    record,
    commitCid: result.commit.cid,
    rev: result.commit.rev,
  })

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
}

/**
 * Delete a record from the stratos store
 */
export async function deleteRecord(
  ctx: AppContext,
  input: DeleteRecordInput,
  callerDid: string,
): Promise<{ commit?: { cid: string; rev: string } }> {
  const { repo, collection, rkey } = input

  // Must be deleting own record
  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot delete record for another user')
  }

  // Validate collection
  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
  }

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)

  // Build MST commit outside the write transaction to reduce connection hold time
  const prepared = await prepareCommit(ctx, callerDid, [
    { action: 'delete', collection, rkey, cid: null },
  ])

  const result = await ctx.actorStore.transact(callerDid, async (store) => {
    // Optimistic lock: verify repo root hasn't changed since we read the MST
    const currentRoot = await store.repo.getRootDetailed()
    assertRootUnchanged(
      currentRoot?.cid.toString() ?? null,
      prepared.rootCid,
    )

    // Check if record exists
    const existing = await store.record.getRecord(uri, null)
    if (!existing) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }

    // Delete from record index
    await store.record.deleteRecord(uri)

    const commitResult = await signAndPersistCommit(
      store.repo,
      ctx.signingKey,
      prepared.unsigned,
    )

    return {
      commit: {
        cid: commitResult.commitCid.toString(),
        rev: commitResult.rev,
      },
    }
  })

  // Sequence the change (deferred, non-blocking)
  deferSequenceChange(ctx, callerDid, {
    action: 'delete',
    uri: uriStr,
    commitCid: result.commit.cid,
    rev: result.commit.rev,
  })

  // Delete stub from user's PDS (background, non-blocking)
  ctx.stubQueue.enqueueDelete(callerDid, collection, rkey)

  return result
}

export interface UpdateRecordInput {
  repo: Did
  collection: string
  rkey: string
  record: unknown
  validate?: boolean
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
): Promise<UpdateRecordOutput> {
  const { repo, collection, rkey, record, validate = true } = input

  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot update record for another user')
  }

  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
  }

  const exists = await ctx.actorStore.exists(callerDid)
  if (!exists) {
    throw new InvalidRequestError('Repo not found', 'RepoNotFound')
  }

  if (validate) {
    await validateWritableRecord(ctx, callerDid, collection, record)
  }

  // Pre-compute CPU-bound work outside the transaction
  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)
  const recordBytes = encodeRecord(record)
  const cid = await computeCid(record)
  const rev = TID.nextStr()

  // Build MST commit outside the write transaction to reduce connection hold time
  const prepared = await prepareCommit(ctx, callerDid, [
    { action: 'update', collection, rkey, cid: cid.toString() },
  ])

  const result = await ctx.actorStore.transact(callerDid, async (store) => {
    // Optimistic lock: verify repo root hasn't changed since we read the MST
    const currentRoot = await store.repo.getRootDetailed()
    assertRootUnchanged(
      currentRoot?.cid.toString() ?? null,
      prepared.rootCid,
    )

    const existing = await store.record.getRecord(uri, null)
    if (!existing) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }

    // Store the record block
    await store.repo.putBlock(cid, recordBytes, rev)

    const commitResult = await signAndPersistCommit(
      store.repo,
      ctx.signingKey,
      prepared.unsigned,
    )

    // Index the record
    await store.record.indexRecord(
      uri,
      cid,
      record as Record<string, unknown>,
      'update',
      commitResult.rev,
    )

    return {
      uri,
      cid,
      cidStr: cid.toString(),
      commit: {
        cid: commitResult.commitCid.toString(),
        rev: commitResult.rev,
      },
    }
  })

  // Sequence the change (deferred, non-blocking)
  deferSequenceChange(ctx, callerDid, {
    action: 'update',
    uri: uriStr,
    cid: cid.toString(),
    record,
    commitCid: result.commit.cid,
    rev: result.commit.rev,
  })

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
): Promise<BatchWriteResult> {
  const exists = await ctx.actorStore.exists(callerDid)
  if (!exists) {
    await ctx.actorStore.create(callerDid)
  }

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

  const result = await ctx.actorStore.transact(callerDid, async (store) => {
    const mstOps: MstWriteOp[] = []
    const indexOps: Array<{
      uri: AtUri
      uriStr: string
      cid: CID | null
      record: unknown
      action: 'create' | 'update' | 'delete'
    }> = []

    for (const pre of precomputed) {
      if (pre.action === 'delete') {
        const existing = await store.record.getRecord(pre.uri, null)
        if (!existing) {
          throw new InvalidRequestError('Record not found', 'RecordNotFound')
        }
        mstOps.push({
          action: 'delete',
          collection: pre.op.collection,
          rkey: pre.rkey,
          cid: null,
        })
        indexOps.push({
          uri: pre.uri,
          uriStr: pre.uriStr,
          cid: null,
          record: undefined,
          action: 'delete',
        })
      } else {
        await store.repo.putBlock(pre.cid, pre.recordBytes, pre.tempRev)

        mstOps.push({
          action: pre.action,
          collection: pre.op.collection,
          rkey: pre.rkey,
          cid: pre.cid.toString(),
        })
        indexOps.push({
          uri: pre.uri,
          uriStr: pre.uriStr,
          cid: pre.cid,
          record: pre.op.record,
          action: pre.action,
        })
      }
    }

    // Preload MST blocks and build single commit for all operations
    const adapter = new StratosBlockStoreReader(store.repo)
    const rootDetails = await store.repo.getRootDetailed()
    if (rootDetails) {
      await store.repo.preloadRootSpine(rootDetails.cid)
    }
    const unsigned = await buildCommit(
      adapter,
      rootDetails?.cid.toString() ?? null,
      {
        did: callerDid,
        writes: mstOps,
      },
    )
    const commitResult = await signAndPersistCommit(
      store.repo,
      ctx.signingKey,
      unsigned,
    )

    // Index records
    const results: Array<{ uri?: string; cid?: string }> = []
    for (const indexOp of indexOps) {
      if (indexOp.action === 'delete') {
        await store.record.deleteRecord(indexOp.uri)
        results.push({})
      } else {
        await store.record.indexRecord(
          indexOp.uri,
          indexOp.cid!,
          indexOp.record as Record<string, unknown>,
          indexOp.action,
          commitResult.rev,
        )
        results.push({ uri: indexOp.uriStr, cid: indexOp.cid!.toString() })
      }
    }

    return {
      results,
      commit: {
        cid: commitResult.commitCid.toString(),
        rev: commitResult.rev,
      },
    }
  })

  // Sequence all changes (deferred, non-blocking)
  deferSequenceChanges(
    ctx,
    callerDid,
    precomputed.map((pre) => {
      if (pre.action === 'delete') {
        return {
          action: 'delete' as const,
          uri: pre.uriStr,
          commitCid: result.commit.cid,
          rev: result.commit.rev,
        }
      }
      return {
        action: pre.action,
        uri: pre.uriStr,
        cid: pre.cid.toString(),
        record: pre.op.record,
        commitCid: result.commit.cid,
        rev: result.commit.rev,
      }
    }),
  )

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
  }

  await store.sequence.appendEvent({
    did: store.did,
    eventType: 'append',
    event: Buffer.from(cborEncode(event)),
    invalidated: 0,
    sequencedAt: new Date().toISOString(),
  })
}

type SequenceOp = {
  action: 'create' | 'update' | 'delete'
  uri: string
  cid?: string
  record?: unknown
  commitCid: string
  rev: string
}

function deferSequenceChange(
  ctx: AppContext,
  callerDid: string,
  op: SequenceOp,
): void {
  ctx.actorStore
    .transact(callerDid, async (store) => {
      await sequenceChange(store, op)
    })
    .catch((err) => {
      ctx.logger?.error(
        { err, did: callerDid, uri: op.uri },
        'failed to sequence change',
      )
    })
}

function deferSequenceChanges(
  ctx: AppContext,
  callerDid: string,
  ops: SequenceOp[],
): void {
  ctx.actorStore
    .transact(callerDid, async (store) => {
      for (const op of ops) {
        await sequenceChange(store, op)
      }
    })
    .catch((err) => {
      ctx.logger?.error(
        { err, did: callerDid },
        'failed to sequence batch changes',
      )
    })
}
