import { AppContext } from '../../context-types.js'
import { createXrpcHandler } from '../util.js'
import { getRecord, listRecords } from '../records'
import { HANDLER_METHOD } from '../handlers'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  exportRepoCarStream,
  StratosRepoRootNotFoundError,
} from '@northskysocial/stratos-core'

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

/**
 * Handler for exporting a full repository as a CAR file.
 *
 * Access is restricted to the repo owner: the authenticated caller must match
 * the requested `did`. This prevents a viewer from exfiltrating boundary-scoped
 * blocks they are not entitled to read.
 *
 * @param ctx - Application Context
 * @returns XRPC handler for exporting a repo
 */
export const getRepoHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, HANDLER_METHOD.SYNC_GET_REPO, {
    handler: async ({ params, did }) => {
      const repoDid = params.did as string
      if (!repoDid) {
        throw new InvalidRequestError('did is required')
      }

      if (did !== repoDid) {
        throw new InvalidRequestError(
          'Only the repo owner may export the repository',
          'RepoNotFound',
        )
      }

      const exists = await ctx.actorStore.exists(repoDid)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const since = params.since as string | undefined

      try {
        const carBytes = await ctx.actorStore.read(repoDid, async (store) => {
          const chunks: Uint8Array[] = []
          for await (const chunk of exportRepoCarStream(store.repo, since)) {
            chunks.push(chunk)
          }
          return Buffer.concat(chunks)
        })

        return {
          encoding: 'application/vnd.ipld.car',
          body: carBytes,
        }
      } catch (err) {
        if (err instanceof StratosRepoRootNotFoundError) {
          throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
        }
        throw err
      }
    },
  })
