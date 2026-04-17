import { Server as XrpcServer } from '@atproto/xrpc-server'
import type { AppContext } from '../context-types.js'
import {
  registerEnrollmentHandlers,
  registerHydrationHandlers,
  registerSyncHandlers,
} from '../features/index.js'
import { type XrpcServerInternal } from './types.js'

import {
  applyWritesHandler,
  createRecordHandler,
  deleteRecordHandler,
  describeRepoHandler,
  getRecordHandler,
  listRecordsHandler,
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
  LIST_BLOBS = 'com.atproto.sync.listBlobs',
  SYNC_GET_RECORD = 'com.atproto.sync.getRecord',
  STRATOS_GET_BLOB = 'zone.stratos.sync.getBlob',
  SYNC_GET_REPO = 'zone.stratos.sync.getRepo',
  STRATOS_UPLOAD_BLOB = 'zone.stratos.repo.uploadBlob',
  IMPORT_REPO = 'zone.stratos.repo.importRepo',
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

  registerEnrollmentHandlers(server, ctx)
  registerHydrationHandlers(server, ctx)
  registerSyncHandlers(server, ctx)
}
