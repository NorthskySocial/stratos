import { Server as XrpcServer, InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import type { AppContext } from '../context.js'
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
} from './records.js'
import { registerHydrationHandlers } from '../features/hydration/handler.js'

type HandlerAuth = {
  credentials: {
    type: string
    did?: string
  }
}

type HandlerInput = {
  body?: unknown
}

type HandlerParams = Record<string, unknown>

type HandlerContext = {
  input?: HandlerInput
  params: HandlerParams
  auth?: HandlerAuth
}

type HandlerResponse = {
  encoding: string
  body: unknown
}

type HandlerFn = (ctx: HandlerContext) => Promise<HandlerResponse>

// Type for accessing internal method - needed until lexicons are properly loaded
type XrpcServerInternal = XrpcServer & {
  method(nsid: string, config: { auth?: (ctx: any) => Promise<any>; handler: HandlerFn }): void
}

/**
 * Register all XRPC handlers with the server
 * Note: Uses internal API until proper lexicon loading is implemented
 */
export function registerHandlers(server: XrpcServer, ctx: AppContext): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx
  
  xrpc.method('com.atproto.repo.createRecord', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const { did } = validateUserAuth(auth)
      const body = input?.body as {
        repo: string
        collection: string
        rkey?: string
        record: unknown
        validate?: boolean
        swapCommit?: string
      }

      ctx.logger?.debug(
        { method: 'createRecord', repo: body.repo, collection: body.collection },
        'handling request',
      )

      try {
        const result = await createRecord(
          ctx,
          {
            repo: body.repo,
            collection: body.collection,
            rkey: body.rkey,
            record: body.record,
            validate: body.validate,
            swapCommit: body.swapCommit,
          },
          did,
        )

        ctx.logger?.info(
          { uri: result.uri, durationMs: Date.now() - start },
          'record created',
        )

        return {
          encoding: 'application/json',
          body: result,
        }
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err), repo: body.repo, collection: body.collection },
          'createRecord failed',
        )
        throw err
      }
    },
  })

  xrpc.method('com.atproto.repo.deleteRecord', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const { did } = validateUserAuth(auth)
      const body = input?.body as {
        repo: string
        collection: string
        rkey: string
        swapRecord?: string
        swapCommit?: string
      }

      ctx.logger?.debug(
        { method: 'deleteRecord', repo: body.repo, collection: body.collection, rkey: body.rkey },
        'handling request',
      )

      try {
        const result = await deleteRecord(
          ctx,
          {
            repo: body.repo,
            collection: body.collection,
            rkey: body.rkey,
            swapRecord: body.swapRecord,
            swapCommit: body.swapCommit,
          },
          did,
        )

        ctx.logger?.info(
          { repo: body.repo, collection: body.collection, rkey: body.rkey, durationMs: Date.now() - start },
          'record deleted',
        )

        return {
          encoding: 'application/json',
          body: result,
        }
      } catch (err) {
        ctx.logger?.error(
          { err: err instanceof Error ? err.message : String(err), repo: body.repo, collection: body.collection, rkey: body.rkey },
          'deleteRecord failed',
        )
        throw err
      }
    },
  })

  // Supports both user auth (owner) and service auth (AppView hydration)
  xrpc.method('com.atproto.repo.getRecord', {
    auth: authVerifier.optionalStandard,
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const typedAuth = auth as HandlerAuth | undefined
      let callerDid: string | undefined
      let callerDomains: string[] = []

      if (typedAuth?.credentials?.did) {
        callerDid = typedAuth.credentials.did

        // For service auth (AppView calling for hydration), use the service's associated user
        // The service JWT should contain the viewer DID it's acting on behalf of
        if (typedAuth.credentials.type === 'service') {
          // Resolve boundaries for the viewer
          callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
        } else if (typedAuth.credentials.type === 'user') {
          // User calling directly - they have access to their own records
          // and any records they share boundaries with
          callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
        }
      }

      ctx.logger?.debug(
        { method: 'getRecord', repo: params.repo, collection: params.collection, rkey: params.rkey },
        'handling request',
      )

      const result = await getRecord(
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

      ctx.logger?.debug(
        { uri: result.uri, durationMs: Date.now() - start },
        'record retrieved',
      )

      return {
        encoding: 'application/json',
        body: result,
      }
    },
  })

  xrpc.method('com.atproto.repo.listRecords', {
    auth: authVerifier.optionalStandard,
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const callerDid = (auth as HandlerAuth | undefined)?.credentials?.did
      let callerDomains: string[] = []
      
      if (callerDid) {
        callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
      }

      ctx.logger?.debug(
        { method: 'listRecords', repo: params.repo, collection: params.collection, limit: params.limit },
        'handling request',
      )

      const result = await listRecords(
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

      ctx.logger?.debug(
        { count: result.records.length, durationMs: Date.now() - start },
        'records listed',
      )

      return {
        encoding: 'application/json',
        body: result,
      }
    },
  })

  xrpc.method('app.stratos.enrollment.status', {
    handler: async ({ params }: HandlerContext) => {
      const did = params.did as string
      if (!did) {
        throw new InvalidRequestError('DID required', 'MissingDid')
      }

      const isEnrolled = await ctx.enrollmentStore.isEnrolled(did)

      return {
        encoding: 'application/json',
        body: {
          did,
          enrolled: isEnrolled,
        },
      }
    },
  })

  registerHydrationHandlers(server, ctx)
}

/**
 * Validate that user authentication is present
 */
function validateUserAuth(auth: unknown): { did: string } {
  const typed = auth as HandlerAuth | undefined

  if (!typed?.credentials?.did) {
    throw new AuthRequiredError('Authentication required')
  }

  if (typed.credentials.type !== 'user') {
    throw new AuthRequiredError('User authentication required')
  }

  return { did: typed.credentials.did }
}
