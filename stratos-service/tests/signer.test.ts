import { describe, it, expect, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import * as AtcuteCid from '@atcute/cid'
import { decode as cborDecode, isBytes, fromBytes } from '@atcute/cbor'
import type { CidLink } from '@atcute/cid'
import { MemoryBlockStore } from '@atcute/mst'
import { signAndPersistCommit } from '../src/features'
import {
  buildCommit,
  type UnsignedCommitData,
} from '@northskysocial/stratos-core'
import { BlockMap } from '@northskysocial/stratos-core'

import type { ActorRepoTransactor } from '../src/actor-store-types.js'

const DID = 'did:plc:testsigner'

async function makeCidStr(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data)
  const cid = await AtcuteCid.create(0x71, bytes)
  return AtcuteCid.toString(cid)
}

function createMockKeypair() {
  return {
    sign: vi.fn(async (data: Uint8Array) => {
      // Deterministic fake signature: SHA-256-sized placeholder
      const sig = new Uint8Array(64)
      for (let i = 0; i < Math.min(data.length, 64); i++) {
        sig[i] = data[i] ^ 0x42
      }
      return sig
    }),
    did: () => DID,
    jwtAlg: 'ES256K' as const,
    export: vi.fn(),
  }
}

function createMockRepoTransactor(): ActorRepoTransactor {
  const blocks = new Map<string, Uint8Array>()
  let rootCid: CID | null = null
  let rootRev: string | null = null

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    putBlock: vi.fn(async (cid: CID, bytes: Uint8Array, _rev: string) => {
      blocks.set(cid.toString(), bytes)
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    deleteBlocks: vi.fn(async (_cids: CID[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    updateRoot: vi.fn(async (cid: CID, rev: string, _did: string) => {
      rootCid = cid
      rootRev = rev
    }),
    getBytes: vi.fn(async (cid: CID) => blocks.get(cid.toString()) ?? null),
    has: vi.fn(async (cid: CID) => blocks.has(cid.toString())),
    getBlocks: vi.fn(async (cids: CID[]) => {
      const found = new BlockMap()
      const missing: CID[] = []
      for (const cid of cids) {
        const b = blocks.get(cid.toString())
        if (b) found.set(cid, b)
        else missing.push(cid)
      }
      return { blocks: found, missing }
    }),
    getRoot: vi.fn(async () => rootCid),
    getRootDetailed: vi.fn(async () =>
      rootCid && rootRev ? { cid: rootCid, rev: rootRev } : null,
    ),
    hasRoot: vi.fn(async () => rootCid !== null),
    putBlocks: vi.fn(),
    deleteBlock: vi.fn(),
    deleteBlocksForRev: vi.fn(),
    clearCache: vi.fn(),
    cache: new BlockMap(),
    iterateCarBlocks: vi.fn(async function* () {}),
    countBlocks: vi.fn(async () => blocks.size),
    listExistingBlocks: vi.fn(),
    getBlockRange: vi.fn(),
    // Internal access for tests
    _blocks: blocks as unknown,
    _getRootCid: () => rootCid,
  } as unknown as ActorRepoTransactor
}

describe('signAndPersistCommit', () => {
  it('should produce a valid signed commit with CID', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('record-1')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'abc',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    const result = await signAndPersistCommit(transactor, keypair, unsigned)

    expect(result.commitCid).toBeInstanceOf(CID)
    expect(result.commitBytes).toBeInstanceOf(Uint8Array)
    expect(result.commitBytes.length).toBeGreaterThan(0)
    expect(result.rev).toBe(unsigned.rev)
  })

  it('should call keypair.sign with CBOR-encoded unsigned commit', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('record-for-sign')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'x1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    await signAndPersistCommit(transactor, keypair, unsigned)

    expect(keypair.sign).toHaveBeenCalledOnce()
    const signedBytes = keypair.sign.mock.calls[0][0]
    expect(signedBytes).toBeInstanceOf(Uint8Array)
    expect(signedBytes.length).toBeGreaterThan(0)

    // Decode the bytes that were signed — should be valid CBOR with commit fields
    const decoded = cborDecode(signedBytes) as Record<string, unknown>
    expect(decoded.did).toBe(DID)
    expect(decoded.version).toBe(3)
    expect((decoded.data as CidLink).$link).toBe(unsigned.data)
    expect(decoded.rev).toBe(unsigned.rev)
    expect(decoded.prev).toBeNull()
  })

  it('should persist all new blocks from the unsigned commit', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('persist-test')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'p1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    await signAndPersistCommit(transactor, keypair, unsigned)

    // newBlocks + 1 commit block
    const expectedBlockCount = unsigned.newBlocks.size + 1
    expect(transactor.putBlock).toHaveBeenCalledTimes(expectedBlockCount)

    // Each newBlock should have been persisted with the correct rev
    for (const [cidStr] of unsigned.newBlocks) {
      const matchingCall = transactor.putBlock.mock.calls.find(
        (call: [CID, Uint8Array, string]) => call[0].toString() === cidStr,
      )
      expect(matchingCall).toBeDefined()
      expect(matchingCall![2]).toBe(unsigned.rev)
    }
  })

  it('should update the repo root with the commit CID', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('root-test')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'r1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    const result = await signAndPersistCommit(transactor, keypair, unsigned)

    expect(transactor.updateRoot).toHaveBeenCalledOnce()
    expect(transactor.updateRoot).toHaveBeenCalledWith(
      result.commitCid,
      unsigned.rev,
      DID,
    )
  })

  it('should produce a commit CID that matches dag-cbor codec', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('codec-test')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'c1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    const result = await signAndPersistCommit(transactor, keypair, unsigned)

    // dag-cbor codec = 0x71
    expect(result.commitCid.code).toBe(0x71)
    // CID v1
    expect(result.commitCid.version).toBe(1)
  })

  it('should produce decodable CBOR commit bytes with signature', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('cbor-test')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 's1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    const result = await signAndPersistCommit(transactor, keypair, unsigned)

    const decoded = cborDecode(result.commitBytes) as Record<string, unknown>
    expect(decoded.did).toBe(DID)
    expect(decoded.version).toBe(3)
    expect((decoded.data as CidLink).$link).toBe(unsigned.data)
    expect(decoded.rev).toBe(unsigned.rev)
    expect(isBytes(decoded.sig)).toBe(true)
    expect(fromBytes(decoded.sig as Uint8Array).length).toBe(64)
  })

  it('should delete removed CIDs when present', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCidStr('record-1')
    const cid2 = await makeCidStr('record-2')

    // Create initial commit with two records
    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'a1',
          cid: cid1,
        },
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'a2',
          cid: cid2,
        },
      ],
    })

    const removedCid = await makeCidStr('removed-block')
    const unsignedWithRemovals: UnsignedCommitData = {
      ...first,
      removedCids: [removedCid],
    }

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    await signAndPersistCommit(transactor, keypair, unsignedWithRemovals)

    expect(transactor.deleteBlocks).toHaveBeenCalledOnce()
    expect(transactor.deleteBlocks.mock.calls[0][0]).toHaveLength(1)
  })

  it('should not call deleteBlocks when removedCids is empty', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('no-deletes')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'd1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    await signAndPersistCommit(transactor, keypair, unsigned)

    expect(transactor.deleteBlocks).not.toHaveBeenCalled()
  })

  it('should persist the commit block itself as the last putBlock call', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCidStr('order-test')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        {
          action: 'create',
          collection: 'zone.stratos.feed.post',
          rkey: 'o1',
          cid: recordCid,
        },
      ],
    })

    const keypair = createMockKeypair()
    const transactor = createMockRepoTransactor()

    const result = await signAndPersistCommit(transactor, keypair, unsigned)

    // The last putBlock call should be for the commit block itself
    const lastCall = transactor.putBlock.mock.calls.at(-1)!
    expect(lastCall[0].toString()).toBe(result.commitCid.toString())
    expect(lastCall[1]).toEqual(result.commitBytes)
  })
})
