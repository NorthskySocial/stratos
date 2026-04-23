import { InvalidRequestError } from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import { StratosValidator } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { ListRecordsResult, RecordResult } from './types.js'

export interface GetRecordInput {
  repo: string
  collection: string
  rkey: string
  cid?: string
}

export interface ListRecordsInput {
  repo: string
  collection: string
  limit?: number
  cursor?: string
  reverse?: boolean
}

/**
 * Get a record from the stratos store
 *
 * @param ctx - Application context
 * @param input - Get record input parameters
 * @param callerDid - DID of the caller
 * @param callerDomains - Domains associated with the caller
 * @returns Record details including URI, CID, and value
 */
export async function getRecord(
  ctx: AppContext,
  input: GetRecordInput,
  callerDid?: string,
  callerDomains?: string[],
): Promise<RecordResult> {
  const { repo, collection, rkey, cid } = input
  const uri = `at://${repo}/${collection}/${rkey}`

  // Check if actor store exists
  const exists = await ctx.actorStore.exists(repo)
  if (!exists) {
    throw new InvalidRequestError('Record not found', 'RecordNotFound')
  }

  return await ctx.actorStore.read(repo, async (store) => {
    const record = await store.record.getRecord(
      new AtUriSyntax(uri),
      cid ?? null,
    )
    if (!record || !record.value) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }

    // Check domain boundary if caller is not the owner
    if (callerDid !== repo) {
      const boundary = StratosValidator.extractBoundaryDomains(record.value)
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
      uri: uri,
      cid: record.cid,
      value: record.value,
    }
  })
}

/**
 * List records from the stratos store
 *
 * @param ctx - Application context
 * @param input - List records input parameters
 * @param callerDid - DID of the caller
 * @param callerDomains - Domains associated with the caller
 * @returns List of records
 */
export async function listRecords(
  ctx: AppContext,
  input: ListRecordsInput,
  callerDid?: string,
  callerDomains?: string[],
): Promise<ListRecordsResult> {
  const { repo, collection, limit = 50, cursor, reverse = false } = input

  // Check if actor store exists
  const exists = await ctx.actorStore.exists(repo)
  if (!exists) {
    return { records: [] }
  }

  return await ctx.actorStore.read(repo, async (store) => {
    const list = await store.record.listRecordsForCollection({
      collection,
      limit,
      cursor,
      reverse,
    })

    const records = list
      .filter((record) => {
        // Check domain boundary if caller is not the owner
        if (callerDid !== repo) {
          const boundary = StratosValidator.extractBoundaryDomains(record.value)
          if (boundary.length > 0 && callerDomains) {
            return boundary.some((domain) => callerDomains.includes(domain))
          }
        }
        return true
      })
      .map((record) => ({
        uri: record.uri.toString(),
        cid: record.cid,
        value: record.value,
      }))

    return {
      records,
      cursor:
        list.length > 0 ? list[list.length - 1].uri.toString() : undefined,
    }
  })
}
