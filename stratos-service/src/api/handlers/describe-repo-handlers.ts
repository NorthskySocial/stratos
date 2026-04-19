import { InvalidRequestError } from '@atproto/xrpc-server'
import { createXrpcHandler } from '../util.js'
import { AppContext } from '../../context-types.js'
import { HANDLER_METHOD } from '../handlers'

/**
 * Handler for describing a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for describing a repository
 * @throws InvalidRequestError if the repository does not exist
 */
export const describeRepoHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, HANDLER_METHOD.DESCRIBE_REPO, {
    requireAuth: false,
    handler: async ({ params }) => {
      const repo = params.repo as string
      if (!repo) {
        throw new InvalidRequestError('repo is required')
      }

      const exists = await ctx.actorStore.exists(repo)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const collections = await ctx.actorStore.read(repo, async (store) => {
        return store.record.listCollections()
      })

      let didDoc: unknown
      let handle: string | undefined
      let handleIsCorrect = false
      try {
        const resolved = await ctx.idResolver.did.resolve(repo)
        if (resolved) {
          didDoc = resolved
          const alsoKnownAs = (resolved as { alsoKnownAs?: string[] })
            .alsoKnownAs
          if (alsoKnownAs) {
            const atHandle = alsoKnownAs.find((aka: string) =>
              aka.startsWith('at://'),
            )
            if (atHandle) {
              handle = atHandle.replace('at://', '')
            }
          }
        }
      } catch {
        // DID resolution is best-effort
        ctx.logger?.warn({ repo }, 'Could not resolve DID')
      }

      if (handle) {
        try {
          const resolvedDid = await ctx.idResolver.handle.resolve(handle)
          handleIsCorrect = resolvedDid === repo
        } catch {
          handleIsCorrect = false
        }
      }

      return {
        handle: handle ?? repo,
        did: repo,
        didDoc,
        collections,
        handleIsCorrect,
      }
    },
  })
