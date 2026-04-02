import { type Cid } from '@atproto/lex-data'
import { parseCid, type UnsignedCommitData } from '@northskysocial/stratos-core'
import { encode as cborEncode, type LexValue } from '@atproto/lex-cbor'
import * as dagCbor from '@ipld/dag-cbor'
import * as AtcuteCbor from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import * as AtcuteCid from '@atcute/cid'
import * as CAR from '@atcute/car'
import { buildInclusionProof, MemoryBlockStore, NodeStore, OverlayBlockStore, } from '@atcute/mst'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import { InvalidRequestError } from '@atproto/xrpc-server'

import { fromUint8Array as repoFromCar } from '@atcute/repo'
import { signCommit, StratosBlockStoreReader } from '../../features/index.js'
import { validateUserAuth } from '../util.js'
import { AppContext } from '../../context-types.js'
import { ActorTransactor } from '../../actor-store-types.js'
import { encodeVarint } from '../varint.js'

/**
 * Handler for getting a repository record.
 *
 * @param ctx - The application context.
 * @returns a CAR containing the commit block, MST inclusion proof, and
 * record block when an MST commit exists. Falls back to a minimal single-block CAR
 * for legacy repos without an MST commit.
 * @throws InvalidRequestError
 */
export const syncGetRecordHandler =
  (ctx: AppContext) =>
  async ({
    params,
  }: {
    params: Record<string, unknown>
  }): Promise<{ encoding: string; body: Uint8Array }> => {
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
      const uri = new AtUriSyntax(`at://${did}/${collection}/${rkey}`)
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

        const commitRootStr = parseCid(commitRoot).toString()
        const commitBytes = await adapter.get(commitRootStr)
        if (!commitBytes) {
          throw new InvalidRequestError(
            'Commit block not found',
            'RepoNotFound',
          )
        }
        const commitData = AtcuteCbor.decode(commitBytes) as { data: CidLink }
        const mstRoot = commitData.data.$link

        const proofCids = await buildInclusionProof(
          nodeStore,
          mstRoot,
          `${collection}/${rkey}`,
        )

        // Collect all block CIDs: commit + proof nodes + record
        const blockCids = new Set<string>([commitRootStr, ...proofCids])
        blockCids.add(parseCid(record.cid).toString())

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
      const recordCid = parseCid(record.cid)
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
      carBuf.set(headerVarInt, off)
      off += headerVarInt.length
      carBuf.set(header, off)
      off += header.length
      carBuf.set(blockVarInt, off)
      off += blockVarInt.length
      carBuf.set(cidBytes, off)
      off += cidBytes.length
      carBuf.set(recordBytes, off)

      return carBuf
    })

    return {
      encoding: 'application/vnd.ipld.car',
      body: car,
    }
  }

/**
 * Handler for getting a repository.
 *
 * @param ctx - The application context.
 * @returns The repository as a CAR file.
 * @throws InvalidRequestError
 */
export const syncGetRepoHandler =
  (ctx: AppContext) =>
  async ({
    params,
  }: {
    params: Record<string, unknown>
  }): Promise<{ encoding: string; body: Uint8Array }> => {
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

      const commitRootStr = parseCid(commitRoot).toString()
      const rootLink: CidLink = { $link: commitRootStr }
      const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []

      for await (const block of store.repo.iterateCarBlocks()) {
        const parsed = AtcuteCid.fromString(parseCid(block.cid).toString())
        carBlocks.push({ cid: parsed.bytes, data: block.bytes })
      }

      const chunks: Uint8Array[] = []
      for await (const chunk of CAR.writeCarStream([rootLink], carBlocks)) {
        chunks.push(chunk as Uint8Array)
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
  }

/**
 * Handler for importing a repository.
 * @param ctx - Application Context
 * @returns XRPC handler for importing a repository
 */
export const importRepoHandler =
  (ctx: AppContext) =>
  async ({
    input,
    auth,
  }: {
    input: { body: unknown }
    auth?: { credentials?: { did?: string } }
  }): Promise<{ commit: { cid: string } }> => {
    const start = Date.now()
    const { did } = validateUserAuth(auth as import('../types.js').HandlerAuth)

    const carBytes = validateImportInput(ctx, input)
    await ensureRepoNotExists(ctx, did)

    // Parse and verify CAR
    const { blocks, commit, records } = await parseAndVerifyCar(did, carBytes)

    // Re-sign commit root
    const actorSigningKey = await ctx.getActorSigningKey(did)
    const unsigned: UnsignedCommitData = {
      did: did,
      version: 3,
      data: commit.data.$link,
      rev: commit.rev,
      prev: null,
      newBlocks: new Map(),
      removedCids: [],
    }

    const signed = await signCommit(actorSigningKey, unsigned)

    const imported = await ctx.actorStore.transact(did, async (store) => {
      return persistImportedRepo(store, {
        did: did,
        blocks,
        commit,
        records,
        signed,
      })
    })

    const durationMs = Date.now() - start
    ctx.logger?.info(
      {
        did,
        durationMs,
        blockCount: imported.blockCount,
        recordCount: records.length,
      },
      'repository imported',
    )

    return {
      commit: { cid: imported.commit.cid },
    }
  }

/**
 * Validate the input for the importRepoHandler.
 * @param ctx - The applicaton contect
 * @param input - The input to validate
 * @returns The validated input as a Uint8Array
 * @throws InvalidRequestError if the input is invalid
 */
function validateImportInput(
  ctx: AppContext,
  input: { body: unknown },
): Uint8Array {
  const carBytes = input?.body
  if (
    !carBytes ||
    !(carBytes instanceof Uint8Array || Buffer.isBuffer(carBytes))
  ) {
    throw new InvalidRequestError('CAR file body required', 'InvalidCar')
  }

  if (carBytes.length > ctx.cfg.stratos.importMaxBytes) {
    throw new InvalidRequestError(
      `CAR file exceeds maximum size of ${ctx.cfg.stratos.importMaxBytes} bytes`,
      'InvalidCar',
    )
  }
  return carBytes
}

/**
 * Check if the user is enrolled and the repo does not already exist.
 * @param ctx - The application context
 * @param did - The DID of the user
 * @throws InvalidRequestError if the user is not enrolled or the repo already exists
 */
async function ensureRepoNotExists(ctx: AppContext, did: string) {
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
}

/**
 * Parse and verify a CAR file for import.
 * @param did - The DID of the user
 * @param carBytes - The CAR file as a Uint8Array
 * @throws InvalidRequestError if the CAR is invalid
 */
async function parseAndVerifyCar(did: string, carBytes: Uint8Array) {
  const carReader = CAR.fromUint8Array(carBytes)
  const roots = carReader.roots
  if (roots.length !== 1) {
    throw new InvalidRequestError(
      'CAR must have exactly one root',
      'InvalidCar',
    )
  }
  const rootCidLink = roots[0]

  const blocks = new Map<string, Uint8Array>()
  for (const entry of carReader) {
    const cidStr = AtcuteCid.toString(entry.cid)
    const blockBytes = new Uint8Array(entry.bytes)
    const expected = await AtcuteCid.create(
      entry.cid.codec as 0x55 | 0x71,
      blockBytes,
    )
    if (AtcuteCid.toString(expected) !== cidStr) {
      throw new InvalidRequestError(
        'CID does not match block bytes',
        'InvalidCar',
      )
    }
    blocks.set(cidStr, blockBytes)
  }

  const commitBytes = blocks.get(rootCidLink.$link)
  if (!commitBytes) {
    throw new InvalidRequestError(
      'Root commit block not found in CAR',
      'InvalidCar',
    )
  }
  const commit = AtcuteCbor.decode(commitBytes) as {
    did: string
    data: CidLink
    rev: string
    version: number
    sig: Uint8Array
  }
  if (commit.did !== did) {
    throw new InvalidRequestError(
      'Commit DID does not match authenticated user',
      'InvalidCar',
    )
  }

  const records: Array<{ collection: string; rkey: string; cid: string }> = []
  for (const entry of repoFromCar(carBytes)) {
    records.push({
      collection: entry.collection,
      rkey: entry.rkey,
      cid: entry.cid.$link,
    })
  }

  return { blocks, commit, records }
}

/**
 * Persist the imported repository to the actor store.
 * @param store - The actor transactor to use for persistence.
 * @param data - The parsed and verified import data.
 */
async function persistImportedRepo(
  store: ActorTransactor,
  data: {
    did: string
    blocks: Map<string, Uint8Array>
    commit: { rev: string }
    records: Array<{ collection: string; rkey: string; cid: string }>
    signed: {
      commitCid: Cid
      commitBytes: Uint8Array
      rev: string
    }
  },
) {
  let count = 0
  for (const [cidStr, bytes] of data.blocks.entries()) {
    await store.repo.putBlock(parseCid(cidStr), bytes, data.commit.rev)
    count++
  }

  for (const record of data.records) {
    const uri = new AtUriSyntax(
      `at://${data.did}/${record.collection}/${record.rkey}`,
    )
    const recordBytes = data.blocks.get(record.cid)
    if (recordBytes) {
      const value = AtcuteCbor.decode(recordBytes) as Record<string, unknown>
      await store.record.putRecord({
        uri: uri.toString(),
        cid: parseCid(record.cid),
        value,
        content: recordBytes,
        indexedAt: new Date().toISOString(),
      })
    }
  }

  await store.repo.putBlock(
    data.signed.commitCid,
    data.signed.commitBytes,
    data.signed.rev,
  )
  await store.repo.updateRoot(data.signed.commitCid, data.signed.rev, data.did)

  return {
    commit: { cid: data.signed.commitCid.toString(), rev: data.signed.rev },
    blockCount: count,
  }
}
