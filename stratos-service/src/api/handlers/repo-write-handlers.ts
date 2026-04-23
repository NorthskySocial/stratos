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
} from '../records/index.js'
import { createXrpcHandler } from '../util.js'

/**
 * Handler for creating a record in a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for creating a record
 */
export const createRecordHandler = (ctx: AppContext) =>
  createXrpcHandler<CreateRecordInput>(ctx, 'com.atproto.repo.createRecord', {
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
  createXrpcHandler<DeleteRecordInput>(ctx, 'com.atproto.repo.deleteRecord', {
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
  createXrpcHandler(ctx, 'com.atproto.repo.uploadBlob', {
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

      // Phase 2: track the untethered blob in the database
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
  createXrpcHandler<ApplyWritesInput>(ctx, 'com.atproto.repo.applyWrites', {
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
