import { InvalidRequestError } from '@atproto/xrpc-server'
import type { Server as XrpcServer } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { createHydrationContext } from '@northskysocial/stratos-core'
import {
  HydrationServiceImpl,
  ActorStoreRecordResolver,
} from './adapter.js'

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
  method(nsid: string, config: { handler: HandlerFn }): void
}

/**
 * Input for hydrating a batch of records
 */
export interface HydrateRecordsInput {
  /** Array of AT-URIs to hydrate */
  uris: string[]
}

/**
 * Output of batch hydration
 */
export interface HydrateRecordsOutput {
  records: Array<{
    uri: string
    cid: string
    value: Record<string, unknown>
  }>
  notFound: string[]
  blocked: string[]
}

/**
 * Register hydration handlers with the XRPC server
 */
export function registerHydrationHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  
  const recordResolver = new ActorStoreRecordResolver(ctx.actorStore)
  const hydrationService = new HydrationServiceImpl(
    recordResolver,
    ctx.boundaryResolver,
  )

  xrpc.method('app.stratos.repo.hydrateRecords', {
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const body = input?.body as HydrateRecordsInput | undefined

      if (!body?.uris || !Array.isArray(body.uris)) {
        throw new InvalidRequestError('URIs array required', 'InvalidInput')
      }

      if (body.uris.length === 0) {
        return {
          encoding: 'application/json',
          body: {
            records: [],
            notFound: [],
            blocked: [],
          } satisfies HydrateRecordsOutput,
        }
      }

      if (body.uris.length > 100) {
        throw new InvalidRequestError(
          'Maximum of 100 URIs per request',
          'TooManyUris',
        )
      }

      const typed = auth as HandlerAuth | undefined
      const viewerDid = typed?.credentials?.did ?? null

      ctx.logger?.debug(
        { method: 'hydrateRecords', batchSize: body.uris.length, viewerDid },
        'handling request',
      )

      let viewerDomains: string[] = []
      if (viewerDid) {
        viewerDomains = await ctx.boundaryResolver.getBoundaries(viewerDid)
      }

      const context = createHydrationContext(viewerDid, viewerDomains)

      const requests = body.uris.map((uri) => ({ uri }))
      const result = await hydrationService.hydrateRecords(requests, context)

      ctx.logger?.info(
        {
          batchSize: body.uris.length,
          hydrated: result.records.length,
          notFound: result.notFound.length,
          blocked: result.blocked.length,
          durationMs: Date.now() - start,
        },
        'batch hydration completed',
      )

      return {
        encoding: 'application/json',
        body: {
          records: result.records,
          notFound: result.notFound,
          blocked: result.blocked,
        } satisfies HydrateRecordsOutput,
      }
    },
  })

  xrpc.method('app.stratos.repo.hydrateRecord', {
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const uri = params.uri as string | undefined
      const cid = params.cid as string | undefined

      if (!uri) {
        throw new InvalidRequestError('URI required', 'InvalidInput')
      }

      const typed = auth as HandlerAuth | undefined
      const viewerDid = typed?.credentials?.did ?? null

      ctx.logger?.debug(
        { method: 'hydrateRecord', uri, viewerDid },
        'handling request',
      )

      let viewerDomains: string[] = []
      if (viewerDid) {
        viewerDomains = await ctx.boundaryResolver.getBoundaries(viewerDid)
      }

      const context = createHydrationContext(viewerDid, viewerDomains)

      const result = await hydrationService.hydrateRecord({ uri, cid }, context)

      if (result.status === 'not-found') {
        ctx.logger?.debug({ uri }, 'record not found')
        throw new InvalidRequestError('Record not found', 'RecordNotFound')
      }

      if (result.status === 'blocked') {
        ctx.logger?.debug({ uri, viewerDid }, 'record blocked by boundary')
        throw new InvalidRequestError(
          'Record blocked due to boundary restrictions',
          'RecordBlocked',
        )
      }

      if (result.status === 'error') {
        ctx.logger?.error({ uri, error: result.message }, 'hydration error')
        throw new InvalidRequestError(result.message, 'HydrationError')
      }

      ctx.logger?.debug(
        { uri, durationMs: Date.now() - start },
        'record hydrated',
      )

      return {
        encoding: 'application/json',
        body: result.record,
      }
    },
  })
}
