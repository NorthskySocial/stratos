import type { Server as XrpcServer } from '@atproto/xrpc-server'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  createHydrationContext,
  type HydrationResult,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import { ActorStoreRecordResolver, HydrationServiceImpl } from './adapter.js'

import { type XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'

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

  xrpc.method('zone.stratos.repo.hydrateRecords', {
    handler: createXrpcHandler(ctx, 'zone.stratos.repo.hydrateRecords', {
      requireAuth: false,
      handler: async ({ input, auth }) => {
        const body = input as HydrateRecordsInput | undefined
        validateHydrateRecordsInput(body)

        if (body!.uris.length === 0) {
          return {
            records: [],
            notFound: [],
            blocked: [],
          } satisfies HydrateRecordsOutput
        }

        const context = await getHydrationContext(
          ctx,
          auth?.credentials?.did ?? null,
        )
        const requests = body!.uris.map((uri) => ({ uri }))
        const result = await hydrationService.hydrateRecords(requests, context)

        return {
          records: result.records,
          notFound: result.notFound,
          blocked: result.blocked,
        }
      },
    }),
  })

  xrpc.method('zone.stratos.repo.hydrateRecord', {
    handler: createXrpcHandler(ctx, 'zone.stratos.repo.hydrateRecord', {
      requireAuth: false,
      handler: async ({ params, auth }) => {
        const uri = params.uri as string | undefined
        const cid = params.cid as string | undefined

        if (!uri) {
          throw new InvalidRequestError('URI required', 'InvalidInput')
        }

        const context = await getHydrationContext(
          ctx,
          auth?.credentials?.did ?? null,
        )
        const result = await hydrationService.hydrateRecord(
          { uri: uri, cid },
          context,
        )

        handleHydrationResult(result)
        return result
      },
    }),
  })
}

function validateHydrateRecordsInput(body: HydrateRecordsInput | undefined) {
  if (!body?.uris || !Array.isArray(body.uris)) {
    throw new InvalidRequestError('URIs array required', 'InvalidInput')
  }

  if (body.uris.length > 100) {
    throw new InvalidRequestError(
      'Maximum of 100 URIs per request',
      'TooManyUris',
    )
  }
}

async function getHydrationContext(ctx: AppContext, viewerDid: string | null) {
  let viewerDomains: string[] = []
  if (viewerDid) {
    viewerDomains = await ctx.boundaryResolver.getBoundaries(viewerDid)
  }
  return createHydrationContext(viewerDid, viewerDomains)
}

function handleHydrationResult(result: HydrationResult) {
  if (result.status === 'not-found') {
    throw new InvalidRequestError('Record not found', 'RecordNotFound')
  }

  if (result.status === 'blocked') {
    throw new InvalidRequestError(
      'Record blocked due to boundary restrictions',
      'RecordBlocked',
    )
  }

  if (result.status === 'error') {
    throw new InvalidRequestError(result.message, 'HydrationError')
  }
}
