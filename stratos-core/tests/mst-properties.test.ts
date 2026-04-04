import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { MemoryBlockStore } from '@atcute/mst'
import * as AtcuteCid from '@atcute/cid'
import {
  type CidLink,
  decode as cborDecode,
  encode as cborEncode,
  toBytes as cborToBytes,
} from '@atcute/cbor'
import { buildCommit, type MstWriteOp } from '../src/index.js'

const DID = 'did:plc:abc123'

// Helper to create a unique CID string for a given input
async function makeCidStr(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data)
  const cid = await AtcuteCid.create(0x55, bytes) // raw
  return AtcuteCid.toString(cid)
}

// Helper to persist blocks and create a fake commit CID
async function persistAndMakeCommitCid(
  storage: MemoryBlockStore,
  unsigned: Awaited<ReturnType<typeof buildCommit>>,
): Promise<string> {
  for (const [cidStr, bytes] of unsigned.newBlocks.entries()) {
    await storage.put(cidStr, bytes)
  }
  const fakeCommitBlock = cborEncode({
    did: unsigned.did,
    version: 3,
    data: { $link: unsigned.data } as CidLink,
    rev: unsigned.rev,
    prev: null,
    sig: cborToBytes(new Uint8Array(64)),
  })
  const commitCid = AtcuteCid.toString(
    await AtcuteCid.create(0x71, fakeCommitBlock),
  )
  await storage.put(commitCid, fakeCommitBlock)
  return commitCid
}

describe('MST Property-Based Tests', () => {
  // Determinism: same ops = same root CID
  it('should be deterministic (same ops = same root CID)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            collection: fc.stringMatching(/^[a-z0-9.]+[a-z0-9]$/),
            rkey: fc.stringMatching(/^[a-zA-Z0-9._~-]+$/),
            content: fc.string(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (records) => {
          const storage1 = new MemoryBlockStore()
          const storage2 = new MemoryBlockStore()

          const writes: MstWriteOp[] = await Promise.all(
            records.map(async (r) => ({
              action: 'create' as const,
              collection: r.collection,
              rkey: r.rkey,
              cid: await makeCidStr(r.content),
            })),
          )

          const commit1 = await buildCommit(storage1, null, {
            did: DID,
            writes,
          })
          const commit2 = await buildCommit(storage2, null, {
            did: DID,
            writes,
          })

          expect(commit1.data).toBe(commit2.data)
        },
      ),
      { numRuns: 50 },
    )
  })

  // Order independence (for creates)
  it('should be order-independent for creates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(
          [...Array(10).keys()].map((i) => ({
            collection: 'com.example.test',
            rkey: `key-${i}`,
            content: `content-${i}`,
          })),
          { minLength: 5, maxLength: 10 },
        ),
        async (records) => {
          const storage1 = new MemoryBlockStore()
          const storage2 = new MemoryBlockStore()

          const writes1: MstWriteOp[] = await Promise.all(
            records.map(async (r) => ({
              action: 'create' as const,
              collection: r.collection,
              rkey: r.rkey,
              cid: await makeCidStr(r.content),
            })),
          )

          const writes2 = [...writes1].reverse()

          const commit1 = await buildCommit(storage1, null, {
            did: DID,
            writes: writes1,
          })
          const commit2 = await buildCommit(storage2, null, {
            did: DID,
            writes: writes2,
          })

          expect(commit1.data).toBe(commit2.data)
        },
      ),
      { numRuns: 30 },
    )
  })

  // Round-trip serialization (CBOR) - already partially tested but let's make it formal
  it('should have valid CBOR serialization for all new blocks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            collection: fc.constant('zone.stratos.test'),
            rkey: fc.stringMatching(/^[a-zA-Z0-9-]{5,10}$/),
            content: fc.string(),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        async (records) => {
          const storage = new MemoryBlockStore()
          const writes: MstWriteOp[] = await Promise.all(
            records.map(async (r) => ({
              action: 'create' as const,
              collection: r.collection,
              rkey: r.rkey,
              cid: await makeCidStr(r.content),
            })),
          )

          const commit = await buildCommit(storage, null, {
            did: DID,
            writes,
          })

          for (const bytes of commit.newBlocks.values()) {
            expect(() => cborDecode(bytes)).not.toThrow()
          }
        },
      ),
      { numRuns: 20 },
    )
  })

  // Consistency: after applying writes, the MST should contain exactly those records
  // We can't easily query the MST without @atcute/mst or similar, but buildCommit uses it.
  // We can verify that if we "re-apply" the same state, it's idempotent.
  it('should be idempotent when re-applying same state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            collection: fc.constant('zone.stratos.test'),
            rkey: fc.stringMatching(/^[a-zA-Z0-9-]{5,10}$/),
            content: fc.string(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (records) => {
          const storage = new MemoryBlockStore()
          const writes: MstWriteOp[] = await Promise.all(
            records.map(async (r) => ({
              action: 'create' as const,
              collection: r.collection,
              rkey: r.rkey,
              cid: await makeCidStr(r.content),
            })),
          )

          const first = await buildCommit(storage, null, {
            did: DID,
            writes,
          })

          const commitCid = await persistAndMakeCommitCid(storage, first)

          const second = await buildCommit(storage, commitCid, {
            did: DID,
            writes: writes.map((w) => ({ ...w, action: 'update' })),
          })

          expect(second.data).toBe(first.data)
          expect(second.removedCids).toEqual([])
        },
      ),
      { numRuns: 20 },
    )
  })
})
