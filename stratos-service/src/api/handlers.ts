import { Server as XrpcServer } from '@atproto/xrpc-server'
import type { AppContext } from '../context-types.js'
import { registerHydrationHandlers } from '../features/index.js'
import { type XrpcServerInternal } from './types.js'

import {
  applyWritesHandler,
  createRecordHandler,
  deleteRecordHandler,
  describeRepoHandler,
  getRecordHandler,
  importRepoHandler,
  listBlobsHandler,
  listRecordsHandler,
  syncGetRecordHandler,
  syncGetRepoHandler,
  uploadBlobHandler,
} from './handlers/index.js'

/**
 * Register handlers for the application
 * @param server XRPC server instance
 * @param ctx App context
 */
export function registerHandlers(server: XrpcServer, ctx: AppContext) {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  xrpc.method('com.atproto.repo.createRecord', {
    auth: authVerifier.standard,
    handler: createRecordHandler(ctx),
  })

  xrpc.method('com.atproto.repo.deleteRecord', {
    auth: authVerifier.standard,
    handler: deleteRecordHandler(ctx),
  })

  xrpc.method('com.atproto.repo.uploadBlob', {
    auth: authVerifier.standard,
    handler: uploadBlobHandler(ctx),
  })

  xrpc.method('com.atproto.repo.getRecord', {
    auth: authVerifier.optionalStandard,
    handler: getRecordHandler(ctx),
  })

  xrpc.method('com.atproto.repo.listRecords', {
    auth: authVerifier.optionalStandard,
    handler: listRecordsHandler(ctx),
  })

  xrpc.method('com.atproto.repo.describeRepo', {
    handler: describeRepoHandler(ctx),
  })

  xrpc.method('com.atproto.repo.applyWrites', {
    auth: authVerifier.standard,
    handler: applyWritesHandler(ctx),
  })

  xrpc.method('com.atproto.sync.listBlobs', {
    handler: listBlobsHandler(ctx),
  })

  xrpc.method('com.atproto.sync.getRecord', {
    handler: syncGetRecordHandler(ctx),
  })

  xrpc.method('zone.stratos.sync.getRepo', {
    handler: syncGetRepoHandler(ctx),
  })

  xrpc.method('zone.stratos.repo.importRepo', {
    auth: authVerifier.standard,
    handler: importRepoHandler(ctx),
  })

  // Feature handlers
  registerHydrationHandlers(server, ctx)
}
