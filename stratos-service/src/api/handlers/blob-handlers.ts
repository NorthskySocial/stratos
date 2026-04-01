import { AppContext } from '../../context-types.js'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { createXrpcHandler } from '../util.js'

/**
 * List blobs handler for the Stratos service.
 *
 * @param ctx - Application Context
 * @returns XRPC handler for listing blobs
 * @throws InvalidRequestError if the DID is not found
 */
export const listBlobsHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, 'com.atproto.sync.listBlobs', {
    requireAuth: false,
    handler: async ({ params }) => {
      const did = params.did as string
      if (!did) {
        throw new InvalidRequestError('did is required')
      }

      const limit = Math.min(Math.max((params.limit as number) || 500, 1), 1000)
      const cursor = params.cursor as string | undefined
      const since = params.since as string | undefined

      const exists = await ctx.actorStore.exists(did)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const cids = await ctx.actorStore.read(did, async (store) => {
        return store.blob.listBlobs({ since, cursor, limit })
      })

      const nextCursor =
        cids.length === limit ? cids[cids.length - 1] : undefined

      return {
        cids,
        cursor: nextCursor,
      }
    },
  })
