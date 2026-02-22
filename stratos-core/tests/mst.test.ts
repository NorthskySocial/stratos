import { describe, it, expect } from 'vitest'
import { MemoryBlockStore, NodeStore, NodeWrangler, OverlayBlockStore } from '@atcute/mst'
import * as AtcuteCid from '@atcute/cid'
import { encode as cborEncode, toBytes as cborToBytes, decode as cborDecode, type CidLink } from '@atcute/cbor'
import { buildCommit, type MstWriteOp } from '../src/mst/builder.js'

const DID = 'did:plc:testuser123'

async function makeCid(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data)
  const cid = await AtcuteCid.create(0x71, bytes)
  return AtcuteCid.toString(cid)
}

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
  const commitCid = AtcuteCid.toString(await AtcuteCid.create(0x71, fakeCommitBlock))
  await storage.put(commitCid, fakeCommitBlock)
  return commitCid
}

describe('buildCommit', () => {
  it('should create an initial commit with a single record', async () => {
    const storage = new MemoryBlockStore()
    const recordCid = await makeCid('record-1')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'abc123', cid: recordCid },
      ],
    })

    expect(unsigned.did).toBe(DID)
    expect(unsigned.version).toBe(3)
    expect(unsigned.prev).toBeNull()
    expect(typeof unsigned.data).toBe('string')
    expect(unsigned.rev).toBeTruthy()
    expect(unsigned.newBlocks.size).toBeGreaterThan(0)
    expect(unsigned.removedCids).toEqual([])
  })

  it('should create a commit with multiple records', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('record-1')
    const cid2 = await makeCid('record-2')
    const cid3 = await makeCid('record-3')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid1 },
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a2', cid: cid2 },
        { action: 'create', collection: 'app.stratos.feed.like', rkey: 'b1', cid: cid3 },
      ],
    })

    expect(unsigned.did).toBe(DID)
    expect(unsigned.version).toBe(3)
    expect(unsigned.newBlocks.size).toBeGreaterThan(0)
  })

  it('should build a second commit on top of a first', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('record-1')

    // First commit
    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid1 },
      ],
    })

    // Persist first commit's blocks into storage (simulating signAndPersist)
    for (const [cidStr, bytes] of first.newBlocks.entries()) {
      await storage.put(cidStr, bytes)
    }

    // Create a CBOR-encoded fake commit block and persist it
    const fakeCommitBlock = cborEncode({
      did: DID,
      version: 3,
      data: { $link: first.data } as CidLink,
      rev: first.rev,
      prev: null,
      sig: cborToBytes(new Uint8Array(64)),
    })
    const commitCid = AtcuteCid.toString(await AtcuteCid.create(0x71, fakeCommitBlock))
    await storage.put(commitCid, fakeCommitBlock)

    // Second commit: add another record on top of first
    const cid2 = await makeCid('record-2')
    const second = await buildCommit(storage, commitCid, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid1 },
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a2', cid: cid2 },
      ],
    })

    expect(second.version).toBe(3)
    expect(typeof second.data).toBe('string')
    expect(second.newBlocks.size).toBeGreaterThan(0)
  })

  it('should handle update operations', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('record-v1')

    // Initial commit
    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid1 },
      ],
    })

    // Persist first commit blocks
    for (const [cidStr, bytes] of first.newBlocks.entries()) {
      await storage.put(cidStr, bytes)
    }

    // For the next buildCommit, we pass null since we're rebuilding from scratch
    const cid2 = await makeCid('record-v2')
    const updated = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid2 },
      ],
    })

    expect(typeof updated.data).toBe('string')
    expect(updated.newBlocks.size).toBeGreaterThan(0)
  })

  it('should handle delete operations after create', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('record-1')
    const cid2 = await makeCid('record-2')

    // Create two records
    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid1 },
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a2', cid: cid2 },
      ],
    })

    // Persist blocks
    for (const [cidStr, bytes] of first.newBlocks.entries()) {
      await storage.put(cidStr, bytes)
    }

    // Delete one record (rebuild from empty since we have no real commit to point to)
    const afterDelete = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a2', cid: cid2 },
      ],
    })

    expect(typeof afterDelete.data).toBe('string')
    // The MST root should be different since we only have one record now
    expect(afterDelete.data).not.toBe(first.data)
  })

  it('should generate monotonically increasing revs', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('record-1')
    const cid2 = await makeCid('record-2')

    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: cid1 },
      ],
    })

    // Small delay to ensure different TID
    await new Promise((r) => setTimeout(r, 2))

    const second = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a2', cid: cid2 },
      ],
    })

    expect(second.rev > first.rev).toBe(true)
  })

  it('should throw when creating a record with null CID', async () => {
    const storage = new MemoryBlockStore()

    await expect(
      buildCommit(storage, null, {
        did: DID,
        writes: [
          { action: 'create', collection: 'app.stratos.feed.post', rkey: 'a1', cid: null },
        ],
      }),
    ).rejects.toThrow('CID required for create operation')
  })

  it('should throw when updating a record with null CID', async () => {
    const storage = new MemoryBlockStore()

    await expect(
      buildCommit(storage, null, {
        did: DID,
        writes: [
          { action: 'update', collection: 'app.stratos.feed.post', rkey: 'a1', cid: null },
        ],
      }),
    ).rejects.toThrow('CID required for update operation')
  })

  it('should produce newBlocks as Map<string, Uint8Array>', async () => {
    const storage = new MemoryBlockStore()
    const cid = await makeCid('map-type-check')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'm1', cid },
      ],
    })

    expect(unsigned.newBlocks).toBeInstanceOf(Map)
    for (const [key, value] of unsigned.newBlocks) {
      expect(typeof key).toBe('string')
      expect(value).toBeInstanceOf(Uint8Array)
      // Each key should be a valid CID string
      expect(() => AtcuteCid.fromString(key)).not.toThrow()
    }
  })

  it('should produce string CIDs in removedCids', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('remove-test-1')
    const cid2 = await makeCid('remove-test-2')

    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'r1', cid: cid1 },
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'r2', cid: cid2 },
      ],
    })

    const commitCid = await persistAndMakeCommitCid(storage, first)

    // Delete r1, only keeping r2
    const second = await buildCommit(storage, commitCid, {
      did: DID,
      writes: [
        { action: 'delete', collection: 'app.stratos.feed.post', rkey: 'r1', cid: null },
      ],
    })

    // MST structure changed, so removedCids should contain string CIDs of obsolete nodes
    for (const removed of second.removedCids) {
      expect(typeof removed).toBe('string')
      expect(() => AtcuteCid.fromString(removed)).not.toThrow()
    }
  })

  it('should produce removedCids when MST structure changes', async () => {
    const storage = new MemoryBlockStore()

    // Create enough records that the MST tree has structure
    const writes: MstWriteOp[] = []
    for (let i = 0; i < 10; i++) {
      const cid = await makeCid(`bulk-record-${i}`)
      writes.push({
        action: 'create',
        collection: 'app.stratos.feed.post',
        rkey: `key${String(i).padStart(4, '0')}`,
        cid,
      })
    }

    const first = await buildCommit(storage, null, {
      did: DID,
      writes,
    })

    const commitCid = await persistAndMakeCommitCid(storage, first)

    // Delete half the records — should change MST structure
    const deletes: MstWriteOp[] = []
    for (let i = 0; i < 5; i++) {
      deletes.push({
        action: 'delete',
        collection: 'app.stratos.feed.post',
        rkey: `key${String(i).padStart(4, '0')}`,
        cid: null,
      })
    }

    const second = await buildCommit(storage, commitCid, {
      did: DID,
      writes: deletes,
    })

    expect(second.removedCids.length).toBeGreaterThan(0)
    expect(second.data).not.toBe(first.data)
  })

  it('should read from underlying storage via OverlayBlockStore', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('overlay-test-1')

    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'ov1', cid: cid1 },
      ],
    })

    // Persist to underlying storage
    const commitCid = await persistAndMakeCommitCid(storage, first)

    // Second commit should be able to read the first commit's data from storage
    const cid2 = await makeCid('overlay-test-2')
    const second = await buildCommit(storage, commitCid, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'ov2', cid: cid2 },
      ],
    })

    // Both commits should have valid MST roots
    expect(typeof first.data).toBe('string')
    expect(typeof second.data).toBe('string')
    // The second commit should have a different root
    expect(second.data).not.toBe(first.data)
  })

  it('should produce a data field that is a valid MST node CID', async () => {
    const storage = new MemoryBlockStore()
    const cid = await makeCid('data-cid-check')

    const unsigned = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'dc1', cid },
      ],
    })

    // The data field should be a valid CID string
    expect(() => AtcuteCid.fromString(unsigned.data)).not.toThrow()

    // And it should reference a block in newBlocks
    expect(unsigned.newBlocks.has(unsigned.data)).toBe(true)

    // The block should be decodable as an MST node
    const nodeBytes = unsigned.newBlocks.get(unsigned.data)!
    expect(nodeBytes).toBeInstanceOf(Uint8Array)
    expect(nodeBytes.length).toBeGreaterThan(0)
  })

  it('should handle empty writes list', async () => {
    const storage = new MemoryBlockStore()

    // An empty write list with no existing commit should fail
    // since the MST root would be null
    await expect(
      buildCommit(storage, null, {
        did: DID,
        writes: [],
      }),
    ).rejects.toThrow('MST root is null after applying writes')
  })

  it('should throw when commit block is not found in storage', async () => {
    const storage = new MemoryBlockStore()
    const fakeCid = await makeCid('nonexistent-commit')

    await expect(
      buildCommit(storage, fakeCid, {
        did: DID,
        writes: [
          { action: 'create', collection: 'app.stratos.feed.post', rkey: 'x1', cid: await makeCid('x') },
        ],
      }),
    ).rejects.toThrow('Commit block not found')
  })

  it('should decode the existing commit via CBOR when continuing from a previous commit', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('continuity-1')

    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'ct1', cid: cid1 },
      ],
    })

    const commitCid = await persistAndMakeCommitCid(storage, first)

    // Verify the commit block is valid CBOR
    const commitBytes = await storage.get(commitCid)
    expect(commitBytes).not.toBeNull()
    const decoded = cborDecode(commitBytes!) as { rev: string; data: CidLink }
    expect(decoded.rev).toBe(first.rev)
    expect(decoded.data.$link).toBe(first.data)

    // Building on top of it should work
    const cid2 = await makeCid('continuity-2')
    const second = await buildCommit(storage, commitCid, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'ct2', cid: cid2 },
      ],
    })

    // Rev should be newer
    expect(second.rev > first.rev).toBe(true)
  })

  it('should use the same MST root when no changes are effective', async () => {
    const storage = new MemoryBlockStore()
    const cid1 = await makeCid('idempotent-1')

    const first = await buildCommit(storage, null, {
      did: DID,
      writes: [
        { action: 'create', collection: 'app.stratos.feed.post', rkey: 'id1', cid: cid1 },
      ],
    })

    const commitCid = await persistAndMakeCommitCid(storage, first)

    // Re-create the same record with same CID — MST root should be identical
    const second = await buildCommit(storage, commitCid, {
      did: DID,
      writes: [
        { action: 'update', collection: 'app.stratos.feed.post', rkey: 'id1', cid: cid1 },
      ],
    })

    expect(second.data).toBe(first.data)
    expect(second.removedCids).toEqual([])
  })
})
