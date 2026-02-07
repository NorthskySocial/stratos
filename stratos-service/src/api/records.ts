import { InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import { CID } from 'multiformats/cid'
import { TID } from '@atproto/common-web'
import { encode as cborEncode, cidForLex, type LexValue } from '@atproto/lex-cbor'
import { AtUri } from '@atproto/syntax'

import {
  assertStratosValidation,
  PreparedCreate,
  PreparedUpdate,
  PreparedDelete,
  CommitData,
  StratosValidationError,
  extractBoundaryDomains,
  stratosSeq,
} from '@anthropic/stratos-core'

import { AppContext, StratosActorTransactor } from '../context.js'

/**
 * Record creation input
 */
export interface CreateRecordInput {
  repo: string // DID
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
  if (!collection.startsWith('app.stratos.')) {
    throw new InvalidRequestError(
      'Only app.stratos.* collections are supported',
      'InvalidCollection',
    )
  }

  // Generate record key if not provided
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
    try {
      // Note: assertStratosValidation handles post-specific validation internally
      assertStratosValidation(record as Record<string, unknown>, collection, ctx.cfg.stratos)
    } catch (err) {
      if (err instanceof StratosValidationError) {
        throw new InvalidRequestError(err.message, 'InvalidRecord')
      }
      throw err
    }
  }

  // Perform the write
  const result = await ctx.actorStore.transact(callerDid, async (store) => {
    // Create the record in the database
    const uriStr = `at://${callerDid}/${collection}/${rkey}`
    const uri = new AtUri(uriStr)
    const recordBytes = encodeRecord(record)
    const cid = await computeCid(record)

    // Generate revision
    const rev = TID.nextStr()

    // Index the record
    await store.record.indexRecord(uri, cid, record as Record<string, unknown>, 'create', rev)

    // Store in repo
    await store.repo.putBlock(cid, recordBytes, rev)

    // Update root
    await store.repo.updateRoot(cid, rev, callerDid)

    // Sequence the change
    await sequenceChange(store, {
      action: 'create',
      uri: uriStr,
      cid: cid.toString(),
      record,
    })

    return {
      uri,
      cid,
      cidStr: cid.toString(),
      commit: {
        cid: cid.toString(),
        rev,
      },
    }
  })

  // Write stub to user's PDS
  const recordObj = record as Record<string, unknown>
  const createdAt = typeof recordObj.createdAt === 'string'
    ? recordObj.createdAt
    : new Date().toISOString()
  
  const recordType = typeof recordObj.$type === 'string'
    ? recordObj.$type
    : collection

  try {
    await ctx.stubWriter.writeStub(
      callerDid,
      collection,
      rkey,
      recordType,
      result.cid,
      createdAt,
    )
  } catch (err) {
    ctx.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), did: callerDid, collection, rkey },
      'failed to write stub to PDS',
    )
  }

  return {
    uri: result.uri.toString(),
    cid: result.cidStr,
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
  if (!collection.startsWith('app.stratos.')) {
    throw new InvalidRequestError(
      'Only app.stratos.* collections are supported',
      'InvalidCollection',
    )
  }

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUri(uriStr)

  const result = await ctx.actorStore.transact(callerDid, async (store) => {
    // Check if record exists
    const existing = await store.record.getRecord(uri, null)
    if (!existing) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }

    // Delete from record index
    await store.record.deleteRecord(uri)

    // Sequence the change
    await sequenceChange(store, {
      action: 'delete',
      uri: uriStr,
    })

    const rev = TID.nextStr()
    const dummyCid = await computeCid({ dummy: true })

    return {
      commit: {
        cid: dummyCid.toString(),
        rev,
      },
    }
  })

  // Delete stub from user's PDS
  try {
    await ctx.stubWriter.deleteStub(callerDid, collection, rkey)
  } catch (err) {
    ctx.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), did: callerDid, collection, rkey },
      'failed to delete stub from PDS',
    )
  }

  return result
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

  const result = await ctx.actorStore.read(repo, async (store) => {
    const record = await store.record.getRecord(uri, cid ?? null)
    if (!record) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }

    // Check domain boundary if caller is not owner
    if (callerDid !== repo) {
      const boundary = extractBoundaryDomains(record.value as Record<string, unknown>)
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

  return result
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

  const result = await ctx.actorStore.read(repo, async (store) => {
    const records = await store.record.listRecordsForCollection({
      collection,
      limit,
      cursor,
      reverse,
    })

    // Filter by domain boundary if needed
    const filtered = records.filter((record: { uri: string; cid: string; value: Record<string, unknown> }) => {
      if (callerDid === repo) {
        return true // Owner sees everything
      }

      const boundary = extractBoundaryDomains(record.value)
      if (boundary.length === 0 || !callerDomains) {
        return true // No boundary restriction
      }

      return boundary.some((domain) => callerDomains.includes(domain))
    })

    const lastRecord = filtered[filtered.length - 1]
    const nextCursor = lastRecord
      ? `${lastRecord.uri.split('/').pop()}`
      : undefined

    return {
      records: filtered.map((r: { uri: string; cid: string; value: Record<string, unknown> }) => ({
        uri: r.uri,
        cid: r.cid,
        value: r.value,
      })),
      cursor: nextCursor,
    }
  })

  return result
}

// Helper functions

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
  store: StratosActorTransactor,
  op: {
    action: 'create' | 'update' | 'delete'
    uri: string
    cid?: string
    record?: unknown
  },
): Promise<void> {
  // Sequence the change for subscriptions
  const event: LexValue = {
    action: op.action,
    path: new AtUri(op.uri).pathname,
    cid: op.cid,
    record: op.record as LexValue | undefined,
  }

  await store.db.insert(stratosSeq).values({
    did: store.did,
    eventType: 'append',
    event: Buffer.from(cborEncode(event)),
    invalidated: 0,
    sequencedAt: new Date().toISOString(),
  })
}
