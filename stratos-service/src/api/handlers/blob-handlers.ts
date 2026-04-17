import { AppContext } from '../../context-types.js'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { createXrpcHandler } from '../util.js'
import { parseCid } from '@northskysocial/stratos-core'

/**
 * Collects the contents of an async iterable into a single Uint8Array.
 * @param stream - The async iterable to collect.
 * @returns A promise that resolves to a Uint8Array containing the combined contents of the stream.
 */
async function collectStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Get blob handler for the Stratos service.
 *
 * @param ctx - Application Context
 * @returns XRPC handler for getting a blob
 */
export const getBlobHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, 'zone.stratos.sync.getBlob', {
    requireAuth: false,
    handler: async ({ params, auth, did: tokenDid }) => {
      const did = params.did as string
      const cidStr = params.cid as string

      if (!did) {
        throw new InvalidRequestError('did is required')
      }
      if (!cidStr) {
        throw new InvalidRequestError('cid is required')
      }

      const cid = parseCid(cidStr)
      const viewerDid = tokenDid ?? auth?.credentials?.did ?? null

      // Check access
      const hasAccess = await ctx.blobAuth.canAccessBlob(viewerDid, did, cid)
      if (!hasAccess) {
        // According to ATProto spec, if it's private and we don't have access, we might want to return 404 or 403.
        // Stratos usually returns 403 for boundary blocks.
        throw new InvalidRequestError(
          'Access denied to blob due to boundary restrictions',
          'BlobBlocked',
        )
      }

      const exists = await ctx.actorStore.exists(did)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const blob = await ctx.actorStore.read(did, async (store) => {
        const result = await store.blob.getBlob(cid)
        if (!result) return null

        return {
          metadata: {
            mimeType: result.mimeType,
            size: result.size,
          },
          stream: result.stream,
        }
      })

      if (!blob) {
        throw new InvalidRequestError('Blob not found', 'BlobNotFound')
      }

      const body = await collectStream(blob.stream)

      return {
        encoding: blob.metadata.mimeType ?? 'application/octet-stream',
        body: body,
      }
    },
  })

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
