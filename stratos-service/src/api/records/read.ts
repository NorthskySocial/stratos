import { InvalidRequestError } from '@atproto/xrpc-server'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import {
  canAccessRecord,
  isDomainlessRecord,
  MAX_VISIBLE_RECORD_BATCH,
  type VisibleRecordWithBoundaries,
} from '@northskysocial/stratos-core'
import type { ActorReader } from '../../actor-store-types.js'
import type { AppContext } from '../../context-types.js'
import { logDomainlessInvariant } from '../../shared/domainless-invariant.js'
import { isAccountTakenDown } from '../../subscription/takedown-filter.js'
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
 * Reads a page of records with their boundary rows, one combined read per
 * chunk of {@link MAX_VISIBLE_RECORD_BATCH}.
 *
 * @param store - The actor store reader to read through
 * @param uris - Record URIs, any number
 * @returns One entry per input URI, in input order; `undefined` for a record
 * that is missing or taken down
 */
export async function readVisibleRecordsInChunks(
  store: ActorReader,
  uris: readonly string[],
): Promise<Array<VisibleRecordWithBoundaries | undefined>> {
  const found = new Map<string, VisibleRecordWithBoundaries>()
  for (let start = 0; start < uris.length; start += MAX_VISIBLE_RECORD_BATCH) {
    const chunk = uris.slice(start, start + MAX_VISIBLE_RECORD_BATCH)
    const chunkFound = await store.record.getVisibleRecordsWithBoundaries(chunk)
    for (const [uri, visible] of chunkFound) {
      found.set(uri, visible)
    }
  }
  return uris.map((uri) => found.get(new AtUriSyntax(uri).toString()))
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

  // A taken-down account reads as a missing record, as a taken-down record does.
  const exists = await ctx.actorStore.exists(repo)
  if (!exists || (await isAccountTakenDown(ctx.labelStore, repo))) {
    throw new InvalidRequestError('Record not found', 'RecordNotFound')
  }

  return await ctx.actorStore.read(repo, async (store) => {
    const found = await store.record.getVisibleRecordWithBoundaries(
      new AtUriSyntax(uri),
    )
    // A pinned cid that is no longer the current one reads as missing.
    if (!found || !found.record.value || (cid && found.record.cid !== cid)) {
      throw new InvalidRequestError('Record not found', 'RecordNotFound')
    }
    const { record, boundaries: recordBoundaries } = found
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

  // A taken-down account lists nothing, as if every record were taken down.
  const exists = await ctx.actorStore.exists(repo)
  if (!exists || (await isAccountTakenDown(ctx.labelStore, repo))) {
    return { records: [] }
  }

  return await ctx.actorStore.read(repo, async (store) => {
    const list = await store.record.listRecordsForCollection({
      collection,
      limit,
      cursor,
      reverse,
    })

    const visible = await readVisibleRecordsInChunks(
      store,
      list.map((record) => record.uri),
    )
    let domainlessCount = 0
    const records = visible.flatMap((found) => {
      if (!found) return []
      const recordBoundaries = found.boundaries
      if (isDomainlessRecord(recordBoundaries)) {
        domainlessCount += 1
      }
      const hasAccess = canAccessRecord({
        recordBoundaries,
        ownerDid: repo,
        context: {
          viewerDid: callerDid ?? null,
          viewerDomains: callerDomains ?? [],
        },
      })
      return hasAccess
        ? [
            {
              uri: found.record.uri,
              cid: found.record.cid,
              value: found.record.value,
            },
          ]
        : []
    })

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
