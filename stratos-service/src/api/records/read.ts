import { InvalidRequestError } from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import {
  canAccessRecord,
  isDomainlessRecord,
  StratosValidator,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { logDomainlessInvariant } from '../../shared/domainless-invariant.js'
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

    const recordBoundaries = StratosValidator.extractBoundaryDomains(
      record.value,
    )
    logDomainlessInvariant(ctx.logger, recordBoundaries, {
      uri,
      ownerDid: repo,
    })
    const hasAccess = canAccessRecord({
      recordBoundaries,
      ownerDid: repo,
      context: {
        viewerDid: callerDid ?? null,
        viewerDomains: callerDomains ?? [],
      },
    })
    if (!hasAccess) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
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

    let domainlessCount = 0
    const records = list
      .filter((record) => {
        const recordBoundaries = StratosValidator.extractBoundaryDomains(
          record.value,
        )
        if (isDomainlessRecord(recordBoundaries)) {
          domainlessCount += 1
        }
        return canAccessRecord({
          recordBoundaries,
          ownerDid: repo,
          context: {
            viewerDid: callerDid ?? null,
            viewerDomains: callerDomains ?? [],
          },
        })
      })
      .map((record) => ({
        uri: record.uri.toString(),
        cid: record.cid,
        value: record.value,
      }))

    if (domainlessCount > 0) {
      ctx.logger?.warn(
        { ownerDid: repo, collection, domainlessCount },
        'invariant violation: records have no domain; treating as fail-closed inaccessible',
      )
    }

    return {
      records,
      cursor:
        list.length > 0 ? list[list.length - 1].uri.toString() : undefined,
    }
  })
}
