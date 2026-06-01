import { Server as XrpcServer } from '@atproto/xrpc-server'
import type { AppContext } from '../../context-types.js'
import { type XrpcServerInternal } from '../../api/types.js'
import { getBlobHandler } from '../../api/handlers/blob-handlers.js'

/**
 * Register sync handlers with the XRPC server
 *
 * @param server - XRPC server
 * @param ctx - Application context
 */
export function registerSyncHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal

  xrpc.method('zone.stratos.sync.getBlob', {
    type: 'query',
    auth: ctx.authVerifier.optionalStandard,
    handler: getBlobHandler(ctx),
  })

  xrpc.method('com.atproto.sync.getBlob', {
    type: 'query',
    auth: ctx.authVerifier.optionalStandard,
    handler: getBlobHandler(ctx),
  })
}
