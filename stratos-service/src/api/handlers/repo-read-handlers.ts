import { AppContext } from '../../context-types.js'
import { createXrpcHandler } from '../util.js'
import { getRecord, listRecords } from '../records'
import { HANDLER_METHOD } from '../handlers'

/**
 * Handler for retrieving a record from a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for getting a record
 */
export const getRecordHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, HANDLER_METHOD.GET_RECORD, {
    requireAuth: false,
    handler: async ({ params, auth }) => {
      let callerDid: string | undefined
      let callerDomains: string[] = []

      if (auth?.credentials?.did) {
        callerDid = auth.credentials.did
        callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
      }

      return await getRecord(
        ctx,
        {
          repo: params.repo as string,
          collection: params.collection as string,
          rkey: params.rkey as string,
          cid: params.cid as string | undefined,
        },
        callerDid,
        callerDomains,
      )
    },
  })

/**
 * Handler for listing records in a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for listing records
 */
export const listRecordsHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, HANDLER_METHOD.LIST_RECORDS, {
    requireAuth: false,
    handler: async ({ params, auth }) => {
      const callerDid = auth?.credentials?.did
      let callerDomains: string[] = []

      if (callerDid) {
        callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
      }

      return await listRecords(
        ctx,
        {
          repo: params.repo as string,
          collection: params.collection as string,
          limit: params.limit as number | undefined,
          cursor: params.cursor as string | undefined,
          reverse: params.reverse as boolean | undefined,
        },
        callerDid,
        callerDomains,
      )
    },
  })
