import type { Server as XrpcServer } from '@atproto/xrpc-server'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  createHydrationContext,
  type HydrationResult,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'

import { type HandlerAuth, type XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { resolveCredentialScope } from '../../infra/auth/credential-scope.js'

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
 *
 * @param server - XRPC server
 * @param ctx - Application context
 */
export function registerHydrationHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { hydrationService } = ctx

  xrpc.method('zone.stratos.repo.hydrateRecords', {
    type: 'procedure',
    auth: ctx.authVerifier.optionalStandardOrSpaceCredential,
    handler: createXrpcHandler(ctx, 'zone.stratos.repo.hydrateRecords', {
      requireAuth: false,
      handler: async (args) => {
        const { input, did, auth } = args
        // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-member-access
        const body = (input ?? (args as any).req?.body) as
          | HydrateRecordsInput
          | undefined
        validateHydrateRecordsInput(body)

        if (body!.uris.length === 0) {
          return {
            records: [],
            notFound: [],
            blocked: [],
          } satisfies HydrateRecordsOutput
        }

        const requests = body!.uris.map((uri) => ({ uri }))
        // Viewer identity is derived strictly from the authenticated
        // credential; a client-supplied `did` cannot override it. A space
        // credential instead scopes visibility to its space's boundary.
        const context = await getHydrationContext(
          ctx,
          did ?? null,
          auth,
          ctx.cfg?.service?.publicUrl,
        )
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
    type: 'query',
    auth: ctx.authVerifier.optionalStandardOrSpaceCredential,
    handler: createXrpcHandler(ctx, 'zone.stratos.repo.hydrateRecord', {
      requireAuth: false,
      handler: async ({ params, did, auth }) => {
        const uri = params.uri as string | undefined
        const cid = params.cid as string | undefined

        if (!uri) {
          throw new InvalidRequestError('URI required', 'InvalidInput')
        }

        // Viewer identity is derived strictly from the authenticated
        // credential; a client-supplied `did` cannot override it. A space
        // credential instead scopes visibility to its space's boundary.
        const context = await getHydrationContext(
          ctx,
          did ?? null,
          auth,
          ctx.cfg?.service?.publicUrl,
        )
        const result = await hydrationService.hydrateRecord(
          { uri: uri, cid },
          context,
        )

        handleHydrationResult(result)
        if (result.status === 'success') {
          return result.record
        }
        throw new InvalidRequestError(
          'Unexpected hydration status',
          'HydrationError',
        )
      },
    }),
  })
}

/**
 * Validate input for hydrateRecords
 * @param body - Input body
 */
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

/**
 * Get hydration context.
 *
 * For a DPoP user, the viewer is the authenticated DID and their enrolled
 * boundaries. For a space credential, the viewer is a synthetic,
 * non-ownable DID scoped to EXACTLY the credential space's boundary — the
 * existing per-record gate then filters every record to that space (fail
 * closed). Credential auth carries no `did`, so it composes with, and never
 * bypasses, the boundary gate.
 *
 * @param ctx - Application context
 * @param viewerDid - DID of the DPoP-authenticated viewer (null otherwise)
 * @param auth - Handler auth context (used to detect a space credential)
 * @param serviceUrl - Base URL for blob hydration
 * @returns Hydration context
 */
async function getHydrationContext(
  ctx: AppContext,
  viewerDid: string | null,
  auth: HandlerAuth | undefined,
  serviceUrl: string | undefined,
) {
  const credentialScope = resolveCredentialScope(auth, ctx.serviceDid)
  if (credentialScope) {
    return createHydrationContext(
      credentialScope.viewerDid,
      credentialScope.viewerDomains,
      serviceUrl ?? '',
    )
  }

  let viewerDomains: string[] = []
  if (viewerDid) {
    viewerDomains = await ctx.boundaryResolver.getBoundaries(viewerDid)
  }
  return createHydrationContext(viewerDid, viewerDomains, serviceUrl ?? '')
}

/**
 * Handle hydration result
 * @param result - Hydration result
 */
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
