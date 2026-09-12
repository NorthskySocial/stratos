import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../context-types.js'
import type { XrpcServerInternal } from '../../api/types.js'

export function registerIdentityHandlers(
  server: Server,
  ctx: Pick<AppContext, 'keyHistory'>,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  xrpc.method('zone.stratos.identity.getKeyHistory', {
    type: 'query',
    handler: () => ({ encoding: 'application/json', body: ctx.keyHistory }),
  })
}
