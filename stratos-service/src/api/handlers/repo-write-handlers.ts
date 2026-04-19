import { Readable } from 'node:stream'
import { type Cid } from '@atproto/lex-data'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { Did } from '@atproto/api'
import { AppContext } from '../../context-types.js'
import {
  applyWritesBatch,
  BatchWriteOp,
  createRecord,
  CreateRecordInput,
  deleteRecord,
  DeleteRecordInput,
} from '../records'
import { createXrpcHandler } from '../util.js'
import { HANDLER_METHOD } from '../handlers'

/**
 * Handler for creating a record in a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for creating a record
 */
export const createRecordHandler = (ctx: AppContext) =>
  createXrpcHandler<CreateRecordInput>(ctx, HANDLER_METHOD.CREATE_RECORD, {
    handler: async ({ input, did, requestId }) => {
      const start = Date.now()
      const body = input

      const result = await createRecord(
        ctx,
        {
          repo: body.repo,
          collection: body.collection,
          rkey: body.rkey,
          record: body.record,
          validate: body.validate,
          swapCommit: body.swapCommit,
          requestId,
        },
        did!,
      )

      const { phases, ...body_result } = result
      const totalMs = Date.now() - start
      const buildMs = phases?.prepareCommitBuild ?? 0
      ctx.logger?.info(
        {
          requestId,
          uri: body_result.uri,
          durationMs: totalMs,
          buildMs,
          buildShare: totalMs > 0 ? Number((buildMs / totalMs).toFixed(4)) : 0,
          phases,
        },
        'record created',
      )

      return body_result
    },
  })

/**
 * Handler for deleting a record in a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for deleting a record
 */
export const deleteRecordHandler = (ctx: AppContext) =>
  createXrpcHandler<DeleteRecordInput>(ctx, HANDLER_METHOD.DELETE_RECORD, {
    handler: async ({ input, did, requestId }) => {
      const body = input

      const result = await deleteRecord(
        ctx,
        {
          repo: body.repo,
          collection: body.collection,
          rkey: body.rkey,
          swapRecord: body.swapRecord,
          swapCommit: body.swapCommit,
          requestId,
        },
        did!,
      )

      const { phases, ...delete_result } = result
      ctx.logger?.info(
        {
          requestId,
          repo: body.repo,
          collection: body.collection,
          rkey: body.rkey,
          phases,
        },
        'record deleted',
      )

      return delete_result
    },
  })

/**
 * Handler for uploading a blob to a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for uploading a blob
 */
export const uploadBlobHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, HANDLER_METHOD.UPLOAD_BLOB, {
    handler: async ({ input, did, requestId, fullInput }) => {
      const start = Date.now()
      const body = input

      if (!body) {
        throw new InvalidRequestError('Request body is required')
      }

      const contentType =
        (fullInput?.encoding as string) || 'application/octet-stream'

      // Collect the body into bytes
      let bytes: Uint8Array
      if (body instanceof Readable) {
        const chunks: Buffer[] = []
        for await (const chunk of body) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        bytes = new Uint8Array(Buffer.concat(chunks))
      } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        bytes = new Uint8Array(body)
      } else {
        throw new InvalidRequestError('Expected binary body')
      }

      if (bytes.length === 0) {
        throw new InvalidRequestError('Blob content is empty')
      }

      // Blob CIDs use raw codec (0x55) + SHA-256, matching the atproto reference
      const hash = await sha256.digest(bytes)
      const cid = CID.createV1(0x55, hash) as unknown as Cid

      // Phase 1: store temp blob (outside transaction, like the atproto PDS)
      const blobstore = ctx.actorStore.getBlobStore(did!)
      const tempKey = await blobstore.putTemp(bytes)

      const ensureActorStoreExists = async (did: string) => {
        const exists = await ctx.actorStore.exists(did)
        if (!exists) {
          await ctx.actorStore.create(did)
        }
      }

      await ensureActorStoreExists(did!)

      // Phase 2: track the untethered blob in the database
      try {
        await ctx.actorStore.transact(did!, async (store) => {
          await store.blob.trackBlob({
            cid,
            mimeType: contentType,
            size: bytes.length,
            tempKey,
          })
        })
      } catch (err) {
        ctx.logger?.error(
          {
            requestId,
            did,
            cid: cid.toString(),
            err:
              err instanceof Error
                ? { message: err.message, stack: err.stack }
                : err,
          },
          'failed to track blob',
        )
        throw err
      }

      ctx.logger?.info(
        {
          requestId,
          did,
          cid: cid.toString(),
          size: bytes.length,
          durationMs: Date.now() - start,
        },
        'blob uploaded',
      )

      return {
        blob: {
          $type: 'blob',
          ref: { $link: cid.toString() },
          mimeType: contentType,
          size: bytes.length,
        },
      }
    },
  })

/**
 * Handler for uploading a blob to the Stratos service.
 * @param ctx - Application Context
 * @returns XRPC handler for uploading a blob
 */
export const stratosUploadBlobHandler = (ctx: AppContext) =>
  createXrpcHandler(ctx, HANDLER_METHOD.STRATOS_UPLOAD_BLOB, {
    handler: async (args) => {
      // The xrpc-server calls the handler with { input, params, auth, req, requestId, did, fullInput }
      // We directly use the implementation of uploadBlobHandler to avoid double-wrapping
      // or trying to call the function returned by createXrpcHandler manually.
      const start = Date.now()
      const { input, fullInput, did, requestId } = args

      ctx.logger?.debug(
        {
          requestId,
          did,
          encoding: fullInput?.encoding,
        },
        'uploading blob (stratos endpoint)',
      )

      const body = input

      const contentType =
        (fullInput?.encoding as string) || 'application/octet-stream'

      // Collect the body into bytes
      let bytes: Uint8Array
      if (body instanceof Readable) {
        const chunks: Buffer[] = []
        for await (const chunk of body) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        bytes = new Uint8Array(Buffer.concat(chunks))
      } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        bytes = new Uint8Array(body)
      } else {
        throw new InvalidRequestError('Expected binary body')
      }

      if (bytes.length === 0) {
        throw new InvalidRequestError('Blob content is empty')
      }

      // Blob CIDs use raw codec (0x55) + SHA-256
      const hash = await sha256.digest(bytes)
      const cid = CID.createV1(0x55, hash) as unknown as Cid

      ctx.logger?.debug(
        {
          requestId,
          did,
          cid: cid.toString(),
          size: bytes.length,
        },
        'blob hashed',
      )

      const blobstore = ctx.actorStore.getBlobStore(did!)
      const tempKey = await blobstore.putTemp(bytes)

      const exists = await ctx.actorStore.exists(did!)
      if (!exists) {
        await ctx.actorStore.create(did!)
      }

      await ctx.actorStore.transact(did!, async (store) => {
        await store.blob.trackBlob({
          cid,
          mimeType: contentType,
          size: bytes.length,
          tempKey,
        })
      })

      ctx.logger?.info(
        {
          requestId,
          did,
          cid: cid.toString(),
          size: bytes.length,
          durationMs: Date.now() - start,
        },
        'blob uploaded (stratos endpoint)',
      )

      return {
        blob: {
          $type: 'blob',
          ref: { $link: cid.toString() },
          mimeType: contentType,
          size: bytes.length,
        },
      }
    },
  })

interface ApplyWritesInput {
  repo: Did
  writes: BatchWriteOp[]
  swapCommit?: string
}

/**
 * Handler for applying a batch of writes to a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for applying writes
 */
export const applyWritesHandler = (ctx: AppContext) =>
  createXrpcHandler<ApplyWritesInput>(ctx, HANDLER_METHOD.APPLY_WRITES, {
    handler: async ({ input, did, requestId }) => {
      const batchResult = await applyWritesBatch(
        ctx,
        did!,
        input.writes,
        requestId,
      )

      return { results: batchResult.results, commit: batchResult.commit }
    },
  })
