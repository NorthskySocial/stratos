import { Readable } from 'node:stream'
import {
  Server as XrpcServer,
  InvalidRequestError,
  AuthRequiredError,
} from '@atproto/xrpc-server'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { AtUri } from '@atproto/syntax'
import { encode as cborEncode, decode as cborDecode, type LexValue } from '@atproto/lex-cbor'
import * as dagCbor from '@ipld/dag-cbor'
import * as AtcuteCbor from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import * as AtcuteCid from '@atcute/cid'
import * as CAR from '@atcute/car'
import { fromUint8Array as repoFromCar } from '@atcute/repo'
import {
  NodeStore,
  OverlayBlockStore,
  MemoryBlockStore,
  buildInclusionProof,
} from '@atcute/mst'
import type { AppContext } from '../context.js'
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  updateRecord,
  applyWritesBatch,
  type BatchWriteOp,
} from './records.js'
import { registerHydrationHandlers } from '../features/index.js'
import { StratosBlockStoreReader } from '../features/mst/index.js'
import { Did } from '@atproto/api'

type HandlerAuth = {
  credentials: {
    type: string
    did?: string
  }
}

type HandlerInput = {
  encoding?: string
  body?: unknown
}

type HandlerParams = Record<string, unknown>

type HandlerContext = {
  input?: HandlerInput
  params: HandlerParams
  auth?: HandlerAuth
}

type HandlerResponse = {
  encoding: string
  body: unknown
}

type HandlerFn = (ctx: HandlerContext) => Promise<HandlerResponse>

// Type for accessing internal method - needed until lexicons are properly loaded
type XrpcServerInternal = XrpcServer & {
  method(
    nsid: string,
    config: {
      auth?: (
        ctx: import('@atproto/xrpc-server').MethodAuthContext,
      ) => Promise<unknown>
      handler: HandlerFn
    },
  ): void
}

/**
 * Register handlers for the application
 * @param server XRPC server instance
 * @param ctx App context
 */
export function registerHandlers(server: XrpcServer, ctx: AppContext): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  xrpc.method('com.atproto.repo.createRecord', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      console.log('[createRecord] handler entered')
      const start = Date.now()
      const { did } = validateUserAuth(auth)
      console.log('[createRecord] auth validated, did:', did)
      const body = input?.body as {
        repo: Did
        collection: string
        rkey?: string
        record: unknown
        validate?: boolean
        swapCommit?: string
      }

      console.log(
        '[createRecord] body:',
        JSON.stringify(body).substring(0, 200),
      )
      ctx.logger?.debug(
        {
          method: 'createRecord',
          repo: body.repo,
          collection: body.collection,
        },
        'handling request',
      )

      try {
        const result = await createRecord(
          ctx,
          {
            repo: body.repo,
            collection: body.collection,
            rkey: body.rkey,
            record: body.record,
            validate: body.validate,
            swapCommit: body.swapCommit,
          },
          did,
        )

        ctx.logger?.info(
          { uri: result.uri, durationMs: Date.now() - start },
          'record created',
        )

        return {
          encoding: 'application/json',
          body: result,
        }
      } catch (err) {
        console.error(
          'createRecord failed:',
          err instanceof Error ? err.message : String(err),
        )
        if (err instanceof Error && err.stack) {
          console.error(err.stack)
        }
        ctx.logger?.error(
          {
            err: err instanceof Error ? err.message : String(err),
            repo: body.repo,
            collection: body.collection,
          },
          'createRecord failed',
        )
        throw err
      }
    },
  })

  xrpc.method('com.atproto.repo.deleteRecord', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const { did } = validateUserAuth(auth)
      const body = input?.body as {
        repo: string
        collection: string
        rkey: string
        swapRecord?: string
        swapCommit?: string
      }

      ctx.logger?.debug(
        {
          method: 'deleteRecord',
          repo: body.repo,
          collection: body.collection,
          rkey: body.rkey,
        },
        'handling request',
      )

      try {
        const result = await deleteRecord(
          ctx,
          {
            repo: body.repo,
            collection: body.collection,
            rkey: body.rkey,
            swapRecord: body.swapRecord,
            swapCommit: body.swapCommit,
          },
          did,
        )

        ctx.logger?.info(
          {
            repo: body.repo,
            collection: body.collection,
            rkey: body.rkey,
            durationMs: Date.now() - start,
          },
          'record deleted',
        )

        return {
          encoding: 'application/json',
          body: result,
        }
      } catch (err) {
        ctx.logger?.error(
          {
            err: err instanceof Error ? err.message : String(err),
            repo: body.repo,
            collection: body.collection,
            rkey: body.rkey,
          },
          'deleteRecord failed',
        )
        throw err
      }
    },
  })

  xrpc.method('com.atproto.repo.uploadBlob', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const { did } = validateUserAuth(auth)

      if (!input?.body) {
        throw new InvalidRequestError('Request body is required')
      }

      const contentType =
        (input.encoding as string) || 'application/octet-stream'

      // Collect the body into bytes
      let bytes: Uint8Array
      if (input.body instanceof Readable) {
        const chunks: Buffer[] = []
        for await (const chunk of input.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        bytes = new Uint8Array(Buffer.concat(chunks))
      } else if (
        input.body instanceof Uint8Array ||
        Buffer.isBuffer(input.body)
      ) {
        bytes = new Uint8Array(input.body as Uint8Array)
      } else {
        throw new InvalidRequestError('Expected binary body')
      }

      if (bytes.length === 0) {
        throw new InvalidRequestError('Blob content is empty')
      }

      // Blob CIDs use raw codec (0x55) + SHA-256, matching the atproto reference
      const RAW_CODEC = 0x55
      const hash = await sha256.digest(bytes)
      const cid = CID.createV1(RAW_CODEC, hash)

      // Phase 1: store temp blob (outside transaction, like the atproto PDS)
      const blobstore = ctx.actorStore.getBlobStore(did)
      const tempKey = await blobstore.putTemp(bytes)

      // Phase 2: track the untethered blob in the database
      await ctx.actorStore.transact(did, async (store) => {
        await store.blob.trackBlob({
          cid,
          mimeType: contentType,
          size: bytes.length,
          tempKey,
        })
      })

      ctx.logger?.info(
        {
          did,
          cid: cid.toString(),
          size: bytes.length,
          durationMs: Date.now() - start,
        },
        'blob uploaded',
      )

      return {
        encoding: 'application/json',
        body: {
          blob: {
            $type: 'blob',
            ref: { $link: cid.toString() },
            mimeType: contentType,
            size: bytes.length,
          },
        },
      }
    },
  })

  // Supports both user auth (owner) and service auth (AppView hydration)
  xrpc.method('com.atproto.repo.getRecord', {
    auth: authVerifier.optionalStandard,
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const typedAuth = auth as HandlerAuth | undefined
      let callerDid: string | undefined
      let callerDomains: string[] = []

      if (typedAuth?.credentials?.did) {
        callerDid = typedAuth.credentials.did

        // For service auth (AppView calling for hydration), use the service's associated user
        // The service JWT should contain the viewer DID it's acting on behalf of
        if (typedAuth.credentials.type === 'service') {
          // Resolve boundaries for the viewer
          callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
        } else if (typedAuth.credentials.type === 'user') {
          // User calling directly - they have access to their own records
          // and any records they share boundaries with
          callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
        }
      }

      ctx.logger?.debug(
        {
          method: 'getRecord',
          repo: params.repo,
          collection: params.collection,
          rkey: params.rkey,
        },
        'handling request',
      )

      const result = await getRecord(
        ctx,
        {
          repo: params.repo as string,
          collection: params.collection as string,
          rkey: params.rkey as string,
          cid: params.cid as string | undefined,
        },
        callerDid,
        callerDomains,
      )

      ctx.logger?.debug(
        { uri: result.uri, durationMs: Date.now() - start },
        'record retrieved',
      )

      return {
        encoding: 'application/json',
        body: result,
      }
    },
  })

  xrpc.method('com.atproto.repo.listRecords', {
    auth: authVerifier.optionalStandard,
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const callerDid = (auth as HandlerAuth | undefined)?.credentials?.did
      let callerDomains: string[] = []

      if (callerDid) {
        callerDomains = await ctx.boundaryResolver.getBoundaries(callerDid)
      }

      ctx.logger?.debug(
        {
          method: 'listRecords',
          repo: params.repo,
          collection: params.collection,
          limit: params.limit,
        },
        'handling request',
      )

      const result = await listRecords(
        ctx,
        {
          repo: params.repo as string,
          collection: params.collection as string,
          limit: params.limit as number | undefined,
          cursor: params.cursor as string | undefined,
          reverse: params.reverse as boolean | undefined,
        },
        callerDid,
        callerDomains,
      )

      ctx.logger?.debug(
        { count: result.records.length, durationMs: Date.now() - start },
        'records listed',
      )

      return {
        encoding: 'application/json',
        body: result,
      }
    },
  })

  xrpc.method('com.atproto.repo.describeRepo', {
    handler: async ({ params }: HandlerContext) => {
      const repo = params.repo as string
      if (!repo) {
        throw new InvalidRequestError('repo is required')
      }

      const exists = await ctx.actorStore.exists(repo)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const collections = await ctx.actorStore.read(repo, async (store) => {
        return store.record.listCollections()
      })

      let didDoc: unknown
      let handle: string | undefined
      let handleIsCorrect = false
      try {
        const resolved = await ctx.idResolver.did.resolve(repo)
        if (resolved) {
          didDoc = resolved
          const alsoKnownAs = (resolved as { alsoKnownAs?: string[] })
            .alsoKnownAs
          if (alsoKnownAs) {
            const atHandle = alsoKnownAs.find((aka: string) =>
              aka.startsWith('at://'),
            )
            if (atHandle) {
              handle = atHandle.replace('at://', '')
            }
          }
        }
      } catch {
        // DID resolution is best-effort
      }

      if (handle) {
        try {
          const resolvedDid = await ctx.idResolver.handle.resolve(handle)
          handleIsCorrect = resolvedDid === repo
        } catch {
          handleIsCorrect = false
        }
      }

      return {
        encoding: 'application/json',
        body: {
          handle: handle ?? repo,
          did: repo,
          didDoc,
          collections,
          handleIsCorrect,
        },
      }
    },
  })

  xrpc.method('com.atproto.repo.applyWrites', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const { did } = validateUserAuth(auth)
      const body = input?.body as {
        repo: string
        writes: Array<{
          $type: string
          collection: string
          rkey?: string
          value?: unknown
        }>
        validate?: boolean
        swapCommit?: string
      }

      if (body.repo !== did) {
        throw new AuthRequiredError("Cannot write to another user's repo")
      }

      if (!body.writes || body.writes.length === 0) {
        throw new InvalidRequestError('writes is required')
      }

      ctx.logger?.debug(
        { method: 'applyWrites', repo: body.repo, count: body.writes.length },
        'handling request',
      )

      const batchOps: BatchWriteOp[] = []

      for (const write of body.writes) {
        const type = write.$type
        if (
          type === 'com.atproto.repo.applyWrites#create' ||
          type === '#create'
        ) {
          batchOps.push({
            action: 'create',
            collection: write.collection,
            rkey: write.rkey ?? '',
            record: write.value,
          })
        } else if (
          type === 'com.atproto.repo.applyWrites#update' ||
          type === '#update'
        ) {
          if (!write.rkey) {
            throw new InvalidRequestError('rkey is required for update')
          }
          batchOps.push({
            action: 'update',
            collection: write.collection,
            rkey: write.rkey,
            record: write.value,
          })
        } else if (
          type === 'com.atproto.repo.applyWrites#delete' ||
          type === '#delete'
        ) {
          if (!write.rkey) {
            throw new InvalidRequestError('rkey is required for delete')
          }
          batchOps.push({
            action: 'delete',
            collection: write.collection,
            rkey: write.rkey,
          })
        } else {
          throw new InvalidRequestError(`Unknown write type: ${type}`)
        }
      }

      const batchResult = await applyWritesBatch(ctx, did, batchOps)

      ctx.logger?.info(
        { count: body.writes.length, durationMs: Date.now() - start },
        'applyWrites completed',
      )

      return {
        encoding: 'application/json',
        body: { results: batchResult.results, commit: batchResult.commit },
      }
    },
  })

  xrpc.method('com.atproto.sync.listBlobs', {
    handler: async ({ params }: HandlerContext) => {
      const did = params.did as string
      if (!did) {
        throw new InvalidRequestError('did is required')
      }

      const limit = Math.min(Math.max((params.limit as number) || 500, 1), 1000)
      const cursor = params.cursor as string | undefined
      const since = params.since as string | undefined

      const exists = await ctx.actorStore.exists(did)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const cids = await ctx.actorStore.read(did, async (store) => {
        return store.blob.listBlobs({ since, cursor, limit })
      })

      const nextCursor =
        cids.length === limit ? cids[cids.length - 1] : undefined

      return {
        encoding: 'application/json',
        body: {
          cids,
          cursor: nextCursor,
        },
      }
    },
  })

  // Returns a CAR containing the commit block, MST inclusion proof, and
  // record block when an MST commit exists. Falls back to a minimal
  // single-block CAR for legacy repos without an MST commit.
  xrpc.method('com.atproto.sync.getRecord', {
    handler: async ({ params }: HandlerContext) => {
      const did = params.did as string
      const collection = params.collection as string
      const rkey = params.rkey as string

      if (!did || !collection || !rkey) {
        throw new InvalidRequestError('did, collection, and rkey are required')
      }

      const exists = await ctx.actorStore.exists(did)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const car = await ctx.actorStore.read(did, async (store) => {
        const uri = new AtUri(`at://${did}/${collection}/${rkey}`)
        const record = await store.record.getRecord(uri, null)
        if (!record) {
          throw new InvalidRequestError('Record not found', 'RecordNotFound')
        }

        const commitRoot = await store.repo.getRoot()

        if (commitRoot) {
          // MST path: return commit + MST inclusion proof + record block
          const adapter = new StratosBlockStoreReader(store.repo)
          const overlay = new OverlayBlockStore(new MemoryBlockStore(), adapter)
          const nodeStore = new NodeStore(overlay)

          const commitRootStr = commitRoot.toString()
          const commitBytes = await adapter.get(commitRootStr)
          if (!commitBytes) {
            throw new InvalidRequestError('Commit block not found', 'RepoNotFound')
          }
          const commitData = AtcuteCbor.decode(commitBytes) as { data: CidLink }
          const mstRoot = commitData.data.$link

          const proofCids = await buildInclusionProof(nodeStore, mstRoot, `${collection}/${rkey}`)

          // Collect all block CIDs: commit + proof nodes + record
          const blockCids = new Set<string>([commitRootStr, ...proofCids])
          const recordCid = CID.parse(record.cid)
          blockCids.add(record.cid)

          // Build CAR
          const rootLink: CidLink = { $link: commitRootStr }
          const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []
          for (const cidStr of blockCids) {
            const bytes = await adapter.get(cidStr)
            if (!bytes) continue
            const parsed = AtcuteCid.fromString(cidStr)
            carBlocks.push({ cid: parsed.bytes, data: bytes })
          }

          const chunks: Uint8Array[] = []
          for await (const chunk of CAR.writeCarStream([rootLink], carBlocks)) {
            chunks.push(chunk)
          }
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
          const result = new Uint8Array(totalLength)
          let offset = 0
          for (const chunk of chunks) {
            result.set(chunk, offset)
            offset += chunk.length
          }
          return result
        }

        // Legacy fallback: minimal single-block CAR
        const recordCid = CID.parse(record.cid)
        let recordBytes = await store.repo.getBytes(recordCid)
        if (!recordBytes) {
          recordBytes = cborEncode(record.value as LexValue)
        }

        const header = dagCbor.encode({ version: 1, roots: [recordCid] })
        const headerVarInt = encodeVarint(header.length)
        const cidBytes = recordCid.bytes
        const blockVarInt = encodeVarint(cidBytes.length + recordBytes.length)

        const carLength =
          headerVarInt.length +
          header.length +
          blockVarInt.length +
          cidBytes.length +
          recordBytes.length

        const carBuf = new Uint8Array(carLength)
        let off = 0
        carBuf.set(headerVarInt, off); off += headerVarInt.length
        carBuf.set(header, off); off += header.length
        carBuf.set(blockVarInt, off); off += blockVarInt.length
        carBuf.set(cidBytes, off); off += cidBytes.length
        carBuf.set(recordBytes, off)

        return carBuf
      })

      return {
        encoding: 'application/vnd.ipld.car',
        body: car,
      }
    },
  })

  xrpc.method('app.stratos.sync.getRepo', {
    handler: async ({ params }: HandlerContext) => {
      const did = params.did as string
      if (!did) {
        throw new InvalidRequestError('did is required')
      }

      const exists = await ctx.actorStore.exists(did)
      if (!exists) {
        throw new InvalidRequestError('Could not find repo', 'RepoNotFound')
      }

      const car = await ctx.actorStore.read(did, async (store) => {
        const commitRoot = await store.repo.getRoot()
        if (!commitRoot) {
          throw new InvalidRequestError('Repo has no commits', 'RepoNotFound')
        }

        const commitRootStr = commitRoot.toString()
        const rootLink: CidLink = { $link: commitRootStr }
        const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []

        for await (const block of store.repo.iterateCarBlocks()) {
          const parsed = AtcuteCid.fromString(block.cid.toString())
          carBlocks.push({ cid: parsed.bytes, data: block.bytes })
        }

        const chunks: Uint8Array[] = []
        for await (const chunk of CAR.writeCarStream([rootLink], carBlocks)) {
          chunks.push(chunk)
        }
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
        const result = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          result.set(chunk, offset)
          offset += chunk.length
        }
        return result
      })

      return {
        encoding: 'application/vnd.ipld.car',
        body: car,
      }
    },
  })

  xrpc.method('app.stratos.repo.importRepo', {
    auth: authVerifier.standard,
    handler: async ({ input, auth }: HandlerContext) => {
      const start = Date.now()
      const { did } = validateUserAuth(auth)

      const carBytes = input?.body as Uint8Array
      if (!carBytes || !(carBytes instanceof Uint8Array)) {
        throw new InvalidRequestError('CAR file body required', 'InvalidCar')
      }

      if (carBytes.length > ctx.cfg.stratos.importMaxBytes) {
        throw new InvalidRequestError(
          `CAR file exceeds maximum size of ${ctx.cfg.stratos.importMaxBytes} bytes`,
          'InvalidCar',
        )
      }

      const isEnrolled = await ctx.enrollmentStore.isEnrolled(did)
      if (!isEnrolled) {
        throw new InvalidRequestError('User is not enrolled', 'NotEnrolled')
      }

      const exists = await ctx.actorStore.exists(did)
      if (exists) {
        const hasRoot = await ctx.actorStore.read(did, async (store) => {
          return (await store.repo.getRoot()) !== null
        })
        if (hasRoot) {
          throw new InvalidRequestError(
            'Repo already exists for this DID',
            'RepoAlreadyExists',
          )
        }
      } else {
        await ctx.actorStore.create(did)
      }

      // Parse and verify CAR
      const carReader = CAR.fromUint8Array(carBytes)
      const roots = carReader.roots
      if (roots.length !== 1) {
        throw new InvalidRequestError('CAR must have exactly one root', 'InvalidCar')
      }
      const rootCidLink = roots[0]

      // Read all blocks from CAR, verifying CID integrity
      const blocks = new Map<string, Uint8Array>()
      for (const entry of carReader) {
        const cidStr = AtcuteCid.toString(entry.cid)
        const blockBytes = new Uint8Array(entry.bytes) as Uint8Array<ArrayBuffer>
        const expected = await AtcuteCid.create(entry.cid.codec as 0x55 | 0x71, blockBytes)
        if (AtcuteCid.toString(expected) !== cidStr) {
          throw new InvalidRequestError('CID does not match block bytes', 'InvalidCar')
        }
        blocks.set(cidStr, blockBytes)
      }

      // Decode and validate the commit
      const commitBytes = blocks.get(rootCidLink.$link)
      if (!commitBytes) {
        throw new InvalidRequestError('Root commit block not found in CAR', 'InvalidCar')
      }
      const commit = AtcuteCbor.decode(commitBytes) as {
        did: string
        data: CidLink
        rev: string
        version: number
        sig: Uint8Array
      }
      if (commit.did !== did) {
        throw new InvalidRequestError('Commit DID does not match authenticated user', 'InvalidCar')
      }
      if (!commit.rev || !commit.data?.$link) {
        throw new InvalidRequestError('Invalid commit structure', 'InvalidCar')
      }

      // Use @atcute/repo to iterate records from the MST
      const records: Array<{ collection: string; rkey: string; cid: string }> = []
      for (const entry of repoFromCar(carBytes)) {
        records.push({
          collection: entry.collection,
          rkey: entry.rkey,
          cid: entry.cid.$link,
        })
      }

      const imported = await ctx.actorStore.transact(did, async (store) => {
        let count = 0

        // Store all blocks from the CAR
        for (const [cidStr, bytes] of blocks) {
          await store.repo.putBlock(CID.parse(cidStr), bytes, commit.rev)
        }

        // Set the repo root
        await store.repo.updateRoot(
          CID.parse(rootCidLink.$link),
          commit.rev,
          did,
        )

        // Index each record
        for (const record of records) {
          const recordBytes = blocks.get(record.cid)
          if (!recordBytes) continue

          const uri = new AtUri(`at://${did}/${record.collection}/${record.rkey}`)
          const value = dagCbor.decode(recordBytes) as Record<string, unknown>

          await store.record.indexRecord(
            uri,
            CID.parse(record.cid),
            value,
            'create',
            commit.rev,
          )
          count++
        }

        return count
      })

      ctx.logger?.info(
        { did, imported, durationMs: Date.now() - start },
        'repo imported',
      )

      return {
        encoding: 'application/json',
        body: { imported },
      }
    },
  })

  xrpc.method('app.stratos.enrollment.status', {
    handler: async ({ params }: HandlerContext) => {
      const did = params.did as string
      if (!did) {
        throw new InvalidRequestError('DID required', 'MissingDid')
      }

      const isEnrolled = await ctx.enrollmentStore.isEnrolled(did)

      return {
        encoding: 'application/json',
        body: {
          did,
          enrolled: isEnrolled,
        },
      }
    },
  })

  registerHydrationHandlers(server, ctx)
}

/**
 * Encode an unsigned integer as a varint (unsigned LEB128)
 */
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  bytes.push(value & 0x7f)
  return new Uint8Array(bytes)
}

/**
 * Validate that user authentication is present
 */
function validateUserAuth(auth: unknown): { did: string } {
  const typed = auth as HandlerAuth | undefined

  if (!typed?.credentials?.did) {
    throw new AuthRequiredError('Authentication required')
  }

  if (typed.credentials.type !== 'user') {
    throw new AuthRequiredError('User authentication required')
  }

  return { did: typed.credentials.did }
}
