import { Server as XrpcServer } from '@atproto/xrpc-server'
import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { type XrpcServerInternal } from '../../api/types.js'
import type { HandlerAuth } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { resolveCredentialScope } from '../../infra/auth/credential-scope.js'
import {
  listRepoOps,
  type ListRepoOpsParams,
  OplogTruncatedError,
} from './oplog.js'
import { listRecordPaths, type ListRecordPathsParams } from './recovery.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/**
 * Resolve the calling service's DID from service-auth credentials.
 * @param auth - Handler auth context
 * @returns The caller service DID
 * @throws AuthRequiredError when the credential is not valid service auth
 */
function requireServiceCaller(auth: HandlerAuth | undefined): string {
  const creds = auth?.credentials as
    | { type?: string; did?: string; iss?: string }
    | undefined
  if (creds?.type !== 'service') {
    throw new AuthRequiredError('Service auth required')
  }
  const callerDid = creds.iss ?? creds.did
  if (!callerDid) {
    throw new AuthRequiredError('Service auth required')
  }
  return callerDid
}

/**
 * Resolve the caller's enrolled boundaries, failing closed on any error or an
 * empty set. A caller with no enrolled boundaries can observe nothing.
 * @param ctx - Application context
 * @param callerDid - The calling service DID
 * @returns The caller's boundary set
 * @throws AuthRequiredError when the caller is enrolled in no boundary
 */
async function resolveCallerBoundaries(
  ctx: AppContext,
  callerDid: string,
): Promise<ReadonlySet<string>> {
  let boundaries: string[]
  try {
    boundaries = await ctx.enrollmentStore.getBoundaries(callerDid)
  } catch (err) {
    // Fail closed: a scope-resolution error must never widen access.
    ctx.logger?.warn(
      { callerDid, err },
      'pull-sync: boundary resolution failed',
    )
    throw new AuthRequiredError('Service is not enrolled in any boundary')
  }
  if (boundaries.length === 0) {
    throw new AuthRequiredError('Service is not enrolled in any boundary')
  }
  return new Set(boundaries)
}

/**
 * Resolve the effective boundary set for a pull-sync request, accepting EITHER
 * inter-service auth (existing behaviour, unchanged) OR a space credential
 * (SWP-07). A space credential for space S yields the singleton `{boundary(S)}`
 * so the same fail-closed oplog/recovery gate returns records in S ONLY.
 *
 * @param ctx - Application context
 * @param auth - Handler auth context
 * @returns The caller's boundary set
 * @throws AuthRequiredError when neither auth path resolves a usable scope
 */
async function resolveEffectiveBoundaries(
  ctx: AppContext,
  auth: HandlerAuth | undefined,
): Promise<ReadonlySet<string>> {
  const credentialScope = resolveCredentialScope(auth, ctx.serviceDid)
  if (credentialScope) {
    return new Set(credentialScope.viewerDomains)
  }
  const callerDid = requireServiceCaller(auth)
  return resolveCallerBoundaries(ctx, callerDid)
}

/**
 * Clamp a caller-supplied limit into `[1, MAX_LIMIT]`, defaulting when absent.
 * @param raw - The raw limit param
 * @returns The effective limit
 */
function resolveLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT
  const n = Math.floor(raw)
  if (n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/**
 * Handler for `zone.stratos.sync.listRepoOps`.
 * @param ctx - Application context
 * @returns XRPC handler
 */
export const listRepoOpsHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, 'zone.stratos.sync.listRepoOps', {
    requireAuth: false,
    handler: async ({ params, auth }) => {
      const callerBoundaries = await resolveEffectiveBoundaries(ctx, auth)

      const did = params.did as string | undefined
      if (!did) {
        throw new InvalidRequestError('did is required')
      }

      if (!(await ctx.actorStore.exists(did))) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const opsParams: ListRepoOpsParams = {
        did,
        since: params.since as string | undefined,
        limit: resolveLimit(params.limit),
        cursor: params.cursor as string | undefined,
        excludeValues: params.excludeValues === true,
      }

      try {
        return await listRepoOps(ctx, opsParams, callerBoundaries)
      } catch (err) {
        if (err instanceof OplogTruncatedError) {
          throw new InvalidRequestError(err.message, 'OplogTruncated')
        }
        throw err
      }
    },
  })

/**
 * Handler for `zone.stratos.sync.listRecordPaths`.
 * @param ctx - Application context
 * @returns XRPC handler
 */
export const listRecordPathsHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, 'zone.stratos.sync.listRecordPaths', {
    requireAuth: false,
    handler: async ({ params, auth }) => {
      const callerBoundaries = await resolveEffectiveBoundaries(ctx, auth)

      const did = params.did as string | undefined
      if (!did) {
        throw new InvalidRequestError('did is required')
      }

      if (!(await ctx.actorStore.exists(did))) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const recoveryParams: ListRecordPathsParams = {
        did,
        collection: params.collection as string | undefined,
        cursor: params.cursor as string | undefined,
        limit: resolveLimit(params.limit),
        excludeValues: params.excludeValues === true,
      }

      return await listRecordPaths(ctx, recoveryParams, callerBoundaries)
    },
  })

/**
 * Register the pull-sync query handlers with the XRPC server. Both are
 * boundary-gated, fail-closed, and require inter-service auth.
 *
 * @param server - XRPC server
 * @param ctx - Application context
 */
export function registerPullSyncHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal

  xrpc.method('zone.stratos.sync.listRepoOps', {
    type: 'query',
    auth: ctx.authVerifier.serviceOrSpaceCredential,
    handler: listRepoOpsHandler(ctx),
  })

  xrpc.method('zone.stratos.sync.listRecordPaths', {
    type: 'query',
    auth: ctx.authVerifier.serviceOrSpaceCredential,
    handler: listRecordPathsHandler(ctx),
  })
}
