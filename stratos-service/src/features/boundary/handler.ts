import { AuthRequiredError, type Server as XrpcServer } from '@atproto/xrpc-server'
import type { BoundarySettings } from '@northskysocial/stratos-core'
import type { AppContext } from '../../context-types.js'
import type { XrpcServerInternal } from '../../api/types.js'
import { createXrpcHandler } from '../../api/util.js'

interface BoundaryMutation {
  boundary: string
  revision: number
}

export function registerBoundaryHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const manager = ctx.boundaryManager
  if (!manager) return
  const xrpc = server as unknown as XrpcServerInternal
  const register = <Input>(
    name: string,
    action: (input: Input) => Promise<unknown>,
  ) => {
    const method = `zone.stratos.admin.${name}`
    xrpc.method(method, {
      type: 'procedure',
      auth: ctx.authVerifier.admin,
      handler: createXrpcHandler<Input>(ctx, method, {
        handler: async ({ input }) => ({ boundary: await action(input) }),
      }),
    })
  }
  register<{ name: string; settings: BoundarySettings }>(
    'createBoundary',
    (input) => manager.create(input.name, input.settings),
  )
  register<BoundaryMutation & { settings: BoundarySettings }>(
    'updateBoundary',
    (input) => manager.update(input.boundary, input.settings, input.revision),
  )
  register<BoundaryMutation>('deactivateBoundary', (input) =>
    manager.deactivate(input.boundary, input.revision),
  )
  register<BoundaryMutation>('reactivateBoundary', (input) =>
    manager.reactivate(input.boundary, input.revision),
  )
  const listMethod = 'zone.stratos.admin.listBoundaries'
  xrpc.method(listMethod, {
    type: 'query',
    auth: ctx.authVerifier.admin,
    handler: createXrpcHandler(ctx, listMethod, {
      handler: async () => ({ boundaries: await manager.list() }),
    }),
  })
  const syncMethod = 'zone.stratos.sync.listBoundaries'
  xrpc.method(syncMethod, {
    type: 'query',
    auth: ctx.authVerifier.service,
    handler: createXrpcHandler(ctx, syncMethod, {
      handler: async ({ auth }) => {
        const did = auth?.credentials.did
        const enrollment = did ? await ctx.enrollmentStore.getEnrollment(did) : null
        if (!did || !enrollment?.active || !enrollment.isService) throw new AuthRequiredError('Service enrollment required')
        const membership = new Set(await ctx.enrollmentStore.getBoundaries(did))
        const definitions = await ctx.boundaryStore!.list()
        return { boundaries: definitions.filter((d) => d.status === 'active' && membership.has(d.boundary)).map((d) => ({
          boundary: d.boundary, roomId: d.roomId, displayName: d.displayName,
          description: d.description, listed: d.listed, joinable: d.joinable, revision: d.revision,
        })) }
      },
    }),
  })
  const roomsMethod = 'zone.stratos.server.listRooms'
  xrpc.method(roomsMethod, {
    type: 'query',
    handler: createXrpcHandler(ctx, roomsMethod, {
      requireAuth: false,
      handler: async () => {
        await ctx.boundaryConfiguration?.refresh()
        return { rooms: ctx.cfg.roomCatalog?.list() ?? [] }
      },
    }),
  })
}
