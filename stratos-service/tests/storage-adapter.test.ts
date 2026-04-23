import { describe, expect, it, vi } from 'vitest'
import { Cid } from '@atproto/lex-data'
import { StratosBlockStoreReader } from '../src/features'
import { BlockMap } from '@northskysocial/stratos-core'
import type { ActorRepoReader } from '../src/actor-store-types.js'
import { createCid as makeCid } from './utils/test-context.js'

function createMockRepoReader(
  blocks: Map<string, Uint8Array>,
): ActorRepoReader {
  return {
    getBytes: vi.fn(async (cid: Cid) => blocks.get(cid.toString()) ?? null),
    has: vi.fn(async (cid: Cid) => blocks.has(cid.toString())),
    getBlocks: vi.fn(async (cids: Cid[]) => {
      const found = new BlockMap()
      const missing: Cid[] = []
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
  it('should parse string CID and delegate to underlying store', async () => {
    const cid = await makeCid('delegate-test')
    const bytes = new TextEncoder().encode('delegate-test')
    const blocks = new Map<string, Uint8Array>([[cid.toString(), bytes]])
    const mockReader = createMockRepoReader(blocks)
    const reader = new StratosBlockStoreReader(mockReader as any)

    await reader.get(cid.toString())

    expect(mockReader.getBytes).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) }),
    )
    const calledCid = vi.mocked(mockReader.getBytes).mock.calls[0][0] as Cid
    expect(calledCid.toString()).toBe(cid.toString())
  })
})
