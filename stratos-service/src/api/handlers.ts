import { registerBoundaryAuditHandlers } from '../features/boundary-audit/handler.js'
import { registerBoundaryHandlers } from '../features/boundary/handler.js'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { registerIdentityHandlers } from '../features/identity/handler.js'
import type { AppContext } from '../context-types.js'
import {
  registerEnrollmentHandlers,
  registerHydrationHandlers,
  registerModerationHandlers,
  registerSpaceCredentialHandlers,
  registerSpaceReadHandlers,
  registerSyncHandlers,
} from '../features/index.js'
import { type XrpcServerInternal } from './types.js'

import {
  applyBoundaryWritesHandler,
  applyWritesHandler,
  createBoundaryRecordHandler,
  createRecordHandler,
  deleteBoundaryRecordHandler,
  deleteRecordHandler,
  describeRepoHandler,
  getRecordHandler,
  getRepoHandler,
  listRecordsHandler,
  putBoundaryRecordHandler,
  stratosUploadBlobHandler,
  uploadBlobHandler,
} from './handlers/index.js'

export enum HANDLER_METHOD {
  CREATE_RECORD = 'com.atproto.repo.createRecord',
  DELETE_RECORD = 'com.atproto.repo.deleteRecord',
  UPLOAD_BLOB = 'com.atproto.repo.uploadBlob',
  GET_RECORD = 'com.atproto.repo.getRecord',
  LIST_RECORDS = 'com.atproto.repo.listRecords',
  DESCRIBE_REPO = 'com.atproto.repo.describeRepo',
  APPLY_WRITES = 'com.atproto.repo.applyWrites',
  STRATOS_GET_BLOB = 'zone.stratos.sync.getBlob',
  SYNC_GET_REPO = 'zone.stratos.sync.getRepo',
  STRATOS_UPLOAD_BLOB = 'zone.stratos.repo.uploadBlob',
  IMPORT_REPO = 'zone.stratos.repo.importRepo',
  CREATE_BOUNDARY_RECORD = 'zone.stratos.repo.createRecord',
  PUT_BOUNDARY_RECORD = 'zone.stratos.repo.putRecord',
  DELETE_BOUNDARY_RECORD = 'zone.stratos.repo.deleteRecord',
  APPLY_BOUNDARY_WRITES = 'zone.stratos.repo.applyWrites',
}

/**
 * Register handlers for the application
 * @param server XRPC server instance
 * @param ctx App context
 */
export function registerHandlers(server: XrpcServer, ctx: AppContext) {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  xrpc.method(HANDLER_METHOD.CREATE_RECORD, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: createRecordHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.DELETE_RECORD, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: deleteRecordHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.UPLOAD_BLOB, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: uploadBlobHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.STRATOS_UPLOAD_BLOB, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: stratosUploadBlobHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.GET_RECORD, {
    type: 'query',
    auth: authVerifier.optionalStandard,
    handler: getRecordHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.LIST_RECORDS, {
    type: 'query',
    auth: authVerifier.optionalStandard,
    handler: listRecordsHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.DESCRIBE_REPO, {
    type: 'query',
    handler: describeRepoHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.APPLY_WRITES, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: applyWritesHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.CREATE_BOUNDARY_RECORD, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: createBoundaryRecordHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.PUT_BOUNDARY_RECORD, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: putBoundaryRecordHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.DELETE_BOUNDARY_RECORD, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: deleteBoundaryRecordHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.APPLY_BOUNDARY_WRITES, {
    type: 'procedure',
    auth: authVerifier.standard,
    handler: applyBoundaryWritesHandler(ctx),
  })

  xrpc.method(HANDLER_METHOD.SYNC_GET_REPO, {
    type: 'query',
    auth: authVerifier.standard,
    handler: getRepoHandler(ctx),
  })

  registerBoundaryAuditHandlers(server, ctx)
  registerIdentityHandlers(server, ctx)
  registerBoundaryHandlers(server, ctx)
  registerEnrollmentHandlers(server, ctx)
  registerHydrationHandlers(server, ctx)
  registerSyncHandlers(server, ctx)
  registerSpaceCredentialHandlers(server, ctx)
  registerSpaceReadHandlers(server, ctx)
  registerModerationHandlers(server, ctx)
}
