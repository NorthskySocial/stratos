import { describe, it, expect, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import * as AtcuteCid from '@atcute/cid'
import { StratosBlockStoreReader } from '../src/features'
import { BlockMap } from '@northskysocial/stratos-core'
import type { ActorRepoReader } from '../src/actor-store-types.js'

const DAG_CBOR_CODEC = 0x71

async function makeCid(data: string): Promise<CID> {
  const bytes = new TextEncoder().encode(data)
  const atcuteCid = await AtcuteCid.create(DAG_CBOR_CODEC, bytes)
  return CID.parse(AtcuteCid.toString(atcuteCid))
}

function createMockRepoReader(
  blocks: Map<string, Uint8Array>,
): ActorRepoReader {
  return {
    getBytes: vi.fn(async (cid: CID) => blocks.get(cid.toString()) ?? null),
    has: vi.fn(async (cid: CID) => blocks.has(cid.toString())),
    getBlocks: vi.fn(async (cids: CID[]) => {
      const found = new BlockMap()
      const missing: CID[] = []
      for (const cid of cids) {
        const bytes = blocks.get(cid.toString())
        if (bytes) {
          found.set(cid, bytes)
        } else {
          missing.push(cid)
        }
      }
      return { blocks: found, missing }
    }),
    getRoot: vi.fn(async () => null),
    getRootDetailed: vi.fn(async () => null),
    hasRoot: vi.fn(async () => false),
    cache: new BlockMap(),
    iterateCarBlocks: vi.fn(async function* () {}),
    countBlocks: vi.fn(async () => 0),
    listExistingBlocks: vi.fn(async () => ({ toList: () => [] })),
    getBlockRange: vi.fn(async () => []),
  } as unknown as ActorRepoReader
}

describe('StratosBlockStoreReader', () => {
  describe('get', () => {
    it('should return bytes for an existing block', async () => {
      const cid = await makeCid('test-block-1')
      const bytes = new TextEncoder().encode('test-block-1')
      const blocks = new Map<string, Uint8Array>([[cid.toString(), bytes]])
      const reader = new StratosBlockStoreReader(createMockRepoReader(blocks))

      const result = await reader.get(cid.toString())
      expect(result).toEqual(bytes)
    })

    it('should return null for a missing block', async () => {
      const cid = await makeCid('nonexistent')
      const reader = new StratosBlockStoreReader(
        createMockRepoReader(new Map()),
      )

      const result = await reader.get(cid.toString())
      expect(result).toBeNull()
    })

    it('should parse string CID and delegate to underlying store', async () => {
      const cid = await makeCid('delegate-test')
      const bytes = new TextEncoder().encode('delegate-test')
      const blocks = new Map<string, Uint8Array>([[cid.toString(), bytes]])
      const mockReader = createMockRepoReader(blocks)
      const reader = new StratosBlockStoreReader(mockReader)

      await reader.get(cid.toString())

      expect(mockReader.getBytes).toHaveBeenCalledWith(
        expect.objectContaining({ toString: expect.any(Function) }),
      )
      const calledCid = mockReader.getBytes.mock.calls[0][0] as CID
      expect(calledCid.toString()).toBe(cid.toString())
    })
  })

  describe('has', () => {
    it('should return true for an existing block', async () => {
      const cid = await makeCid('exists')
      const blocks = new Map<string, Uint8Array>([
        [cid.toString(), new Uint8Array([1])],
      ])
      const reader = new StratosBlockStoreReader(createMockRepoReader(blocks))

      expect(await reader.has(cid.toString())).toBe(true)
    })

    it('should return false for a missing block', async () => {
      const cid = await makeCid('missing')
      const reader = new StratosBlockStoreReader(
        createMockRepoReader(new Map()),
      )

      expect(await reader.has(cid.toString())).toBe(false)
    })
  })

  describe('getMany', () => {
    it('should return found blocks and list missing ones', async () => {
      const cid1 = await makeCid('found-block')
      const cid2 = await makeCid('missing-block')
      const bytes1 = new TextEncoder().encode('found-block')
      const blocks = new Map<string, Uint8Array>([[cid1.toString(), bytes1]])
      const reader = new StratosBlockStoreReader(createMockRepoReader(blocks))

      const result = await reader.getMany([cid1.toString(), cid2.toString()])

      expect(result.found.size).toBe(1)
      expect(result.found.get(cid1.toString())).toEqual(bytes1)
      expect(result.missing).toEqual([cid2.toString()])
    })

    it('should return all found when nothing is missing', async () => {
      const cid1 = await makeCid('block-a')
      const cid2 = await makeCid('block-b')
      const bytes1 = new TextEncoder().encode('block-a')
      const bytes2 = new TextEncoder().encode('block-b')
      const blocks = new Map<string, Uint8Array>([
        [cid1.toString(), bytes1],
        [cid2.toString(), bytes2],
      ])
      const reader = new StratosBlockStoreReader(createMockRepoReader(blocks))

      const result = await reader.getMany([cid1.toString(), cid2.toString()])

      expect(result.found.size).toBe(2)
      expect(result.missing).toEqual([])
    })

    it('should return all missing when nothing is found', async () => {
      const cid1 = await makeCid('missing-1')
      const cid2 = await makeCid('missing-2')
      const reader = new StratosBlockStoreReader(
        createMockRepoReader(new Map()),
      )

      const result = await reader.getMany([cid1.toString(), cid2.toString()])

      expect(result.found.size).toBe(0)
      expect(result.missing).toHaveLength(2)
    })
  })

  describe('CID string round-trip', () => {
    it('should correctly convert between string CIDs and multiformats CID objects', async () => {
      const data = new TextEncoder().encode('round-trip-test')
      const atcuteCid = await AtcuteCid.create(DAG_CBOR_CODEC, data)
      const cidStr = AtcuteCid.toString(atcuteCid)
      const multiformatsCid = CID.parse(cidStr)

      // The string form should survive the round-trip
      expect(multiformatsCid.toString()).toBe(cidStr)

      const blocks = new Map<string, Uint8Array>([[cidStr, data]])
      const reader = new StratosBlockStoreReader(createMockRepoReader(blocks))

      const result = await reader.get(cidStr)
      expect(result).toEqual(data)
    })
  })
})
