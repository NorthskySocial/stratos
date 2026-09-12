import { ensureValidDid } from '@atproto/syntax'
import {
  AuthRequiredError,
  InvalidRequestError,
  type Server,
} from '@atproto/xrpc-server'
import type { AppContext } from '../../context-types.js'
import type {
  HandlerAuth,
  HandlerFn,
  XrpcServerInternal,
} from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'
import { BoundaryHistoryTruncatedError } from './model.js'

function requireAuditAdmin(auth: HandlerAuth, did: unknown): string {
  if (auth.credentials.type !== 'admin') throw new AuthRequiredError()
  if (typeof did !== 'string') throw new InvalidRequestError('did is required')
  try {
    ensureValidDid(did)
  } catch {
    throw new InvalidRequestError('did must be a valid DID')
  }
  return did
}

export function listBoundaryOpsHandler(ctx: AppContext): HandlerFn {
  return createXrpcHandler(ctx, 'zone.stratos.admin.listBoundaryOps', {
    handler: async ({ params, auth }) => {
      const did = requireAuditAdmin(auth!, params.did)
      try {
        return await ctx.boundaryAudit.list(
          did,
          params.limit as number | undefined,
          params.cursor as string | undefined,
        )
      } catch (error) {
        if (error instanceof BoundaryHistoryTruncatedError) {
          throw new InvalidRequestError(
            error.message,
            'BoundaryHistoryTruncated',
          )
        }
        if (error instanceof RangeError)
          throw new InvalidRequestError(error.message)
        throw error
      }
    },
  })
}

export function getBoundaryAuditStateHandler(ctx: AppContext): HandlerFn {
  return createXrpcHandler(ctx, 'zone.stratos.admin.getBoundaryAuditState', {
    handler: async ({ params, auth }) =>
      ctx.boundaryAudit.checkpoint(requireAuditAdmin(auth!, params.did)),
  })
}

export function registerBoundaryAuditHandlers(
  server: Server,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  xrpc.method('zone.stratos.admin.listBoundaryOps', {
    type: 'query',
    auth: ctx.authVerifier.admin,
    handler: listBoundaryOpsHandler(ctx),
  })
  xrpc.method('zone.stratos.admin.getBoundaryAuditState', {
    type: 'query',
    auth: ctx.authVerifier.admin,
    handler: getBoundaryAuditStateHandler(ctx),
  })
}
