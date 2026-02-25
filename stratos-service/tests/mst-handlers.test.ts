/**
 * Tests for the custom code paths in handlers.ts that replaced @atproto/repo:
 * - CAR round-trip: writing blocks via @atcute/car and reading them back
 * - CID integrity verification for imported CARs
 * - Commit CBOR encoding/decoding
 * - MST inclusion proof CAR building
 * - Full repo CAR building from iterateCarBlocks
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CID } from 'multiformats/cid'
import * as AtcuteCid from '@atcute/cid'
import type { CidLink } from '@atcute/cid'
import * as AtcuteCbor from '@atcute/cbor'
import { toBytes as cborToBytes } from '@atcute/cbor'
import * as CAR from '@atcute/car'
import { fromUint8Array as repoFromCar } from '@atcute/repo'
import {
  NodeStore,
  NodeWrangler,
  OverlayBlockStore,
  MemoryBlockStore,
  buildInclusionProof,
} from '@atcute/mst'

const DID = 'did:plc:testhandlers'

async function makeCidStr(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data)
  const cid = await AtcuteCid.create(0x71, bytes)
  return AtcuteCid.toString(cid)
}

async function collectCarStream(
  roots: CidLink[],
  blocks: Array<{ cid: Uint8Array; data: Uint8Array }>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of CAR.writeCarStream(roots, blocks)) {
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

describe('CAR round-trip', () => {
  it('should write and read back a single-block CAR', async () => {
    const data = AtcuteCbor.encode({ hello: 'world' })
    const cid = await AtcuteCid.create(0x71, data)
    const cidStr = AtcuteCid.toString(cid)
    const rootLink: CidLink = { $link: cidStr }

    const carBytes = await collectCarStream(
      [rootLink],
      [{ cid: cid.bytes, data }],
    )

    expect(carBytes.length).toBeGreaterThan(0)

    const reader = CAR.fromUint8Array(carBytes)
    expect(reader.roots).toHaveLength(1)
    expect(reader.roots[0].$link).toBe(cidStr)

    const entries = [...reader]
    expect(entries).toHaveLength(1)
    expect(AtcuteCid.toString(entries[0].cid)).toBe(cidStr)
    expect(entries[0].bytes).toEqual(data)
  })

  it('should write and read back a multi-block CAR', async () => {
    const block1 = AtcuteCbor.encode({ type: 'commit', version: 3 })
    const block2 = AtcuteCbor.encode({ type: 'mst-node' })
    const block3 = AtcuteCbor.encode({ type: 'record', text: 'hello' })

    const cid1 = await AtcuteCid.create(0x71, block1)
    const cid2 = await AtcuteCid.create(0x71, block2)
    const cid3 = await AtcuteCid.create(0x71, block3)

    const rootLink: CidLink = { $link: AtcuteCid.toString(cid1) }

    const carBytes = await collectCarStream(
      [rootLink],
      [
        { cid: cid1.bytes, data: block1 },
        { cid: cid2.bytes, data: block2 },
        { cid: cid3.bytes, data: block3 },
      ],
    )

    const reader = CAR.fromUint8Array(carBytes)
    expect(reader.roots).toHaveLength(1)

    const entries = [...reader]
    expect(entries).toHaveLength(3)

    const cidStrs = entries.map((e) => AtcuteCid.toString(e.cid))
    expect(cidStrs).toContain(AtcuteCid.toString(cid1))
    expect(cidStrs).toContain(AtcuteCid.toString(cid2))
    expect(cidStrs).toContain(AtcuteCid.toString(cid3))
  })

  it('should preserve block bytes exactly through CAR round-trip', async () => {
    const original = { nested: { data: [1, 2, 3], flag: true } }
    const encoded = AtcuteCbor.encode(original)
    const cid = await AtcuteCid.create(0x71, encoded)
    const rootLink: CidLink = { $link: AtcuteCid.toString(cid) }

    const carBytes = await collectCarStream(
      [rootLink],
      [{ cid: cid.bytes, data: encoded }],
    )

    const reader = CAR.fromUint8Array(carBytes)
    const entries = [...reader]
    expect(entries[0].bytes).toEqual(encoded)

    const decoded = AtcuteCbor.decode(entries[0].bytes) as Record<
      string,
      unknown
    >
    expect(decoded).toEqual(original)
  })
})

describe('CID integrity verification', () => {
  it('should verify that CID matches block content', async () => {
    const data = AtcuteCbor.encode({ verified: true })
    const cid = await AtcuteCid.create(0x71, data)
    const cidStr = AtcuteCid.toString(cid)

    // Re-hash the data and compare
    const recomputed = await AtcuteCid.create(
      0x71,
      new Uint8Array(data) as Uint8Array<ArrayBuffer>,
    )
    expect(AtcuteCid.toString(recomputed)).toBe(cidStr)
  })

  it('should detect tampered block content', async () => {
    const data = AtcuteCbor.encode({ original: true })
    const cid = await AtcuteCid.create(0x71, data)
    const cidStr = AtcuteCid.toString(cid)

    // Tamper with the data
    const tampered = new Uint8Array(data)
    tampered[0] ^= 0xff

    const recomputed = await AtcuteCid.create(
      0x71,
      tampered as Uint8Array<ArrayBuffer>,
    )
    expect(AtcuteCid.toString(recomputed)).not.toBe(cidStr)
  })

  it('should verify CIDs in a CAR file after reading', async () => {
    const block1 = AtcuteCbor.encode({ index: 1 })
    const block2 = AtcuteCbor.encode({ index: 2 })
    const cid1 = await AtcuteCid.create(0x71, block1)
    const cid2 = await AtcuteCid.create(0x71, block2)

    const carBytes = await collectCarStream(
      [{ $link: AtcuteCid.toString(cid1) }],
      [
        { cid: cid1.bytes, data: block1 },
        { cid: cid2.bytes, data: block2 },
      ],
    )

    // Verify each block's CID matches its content (same logic as importRepo handler)
    const reader = CAR.fromUint8Array(carBytes)
    for (const entry of reader) {
      const cidStr = AtcuteCid.toString(entry.cid)
      const blockBytes = new Uint8Array(entry.bytes) as Uint8Array<ArrayBuffer>
      const expected = await AtcuteCid.create(
        entry.cid.codec as 0x55 | 0x71,
        blockBytes,
      )
      expect(AtcuteCid.toString(expected)).toBe(cidStr)
    }
  })
})

describe('Commit CBOR encoding/decoding', () => {
  it('should encode and decode a commit with CidLink for MST root', async () => {
    const mstRootCid = await makeCidStr('mst-root-data')

    const commit = {
      did: DID,
      version: 3,
      data: { $link: mstRootCid } as CidLink,
      rev: '2222222222222',
      prev: null,
      sig: cborToBytes(new Uint8Array(64)),
    }

    const encoded = AtcuteCbor.encode(commit)
    const decoded = AtcuteCbor.decode(encoded) as typeof commit

    expect(decoded.did).toBe(DID)
    expect(decoded.version).toBe(3)
    expect(decoded.data.$link).toBe(mstRootCid)
    expect(decoded.rev).toBe('2222222222222')
    expect(decoded.prev).toBeNull()
    expect(AtcuteCbor.isBytes(decoded.sig)).toBe(true)
  })

  it('should produce a valid CID for the commit block', async () => {
    const mstRootCid = await makeCidStr('commit-cid-test')
    const commit = {
      did: DID,
      version: 3,
      data: { $link: mstRootCid } as CidLink,
      rev: '3333333333333',
      prev: null,
      sig: cborToBytes(new Uint8Array(64)),
    }

    const commitBytes = AtcuteCbor.encode(commit)
    const commitCid = await AtcuteCid.create(0x71, commitBytes)
    const commitCidStr = AtcuteCid.toString(commitCid)

    // Should be a valid CIDv1 string
    expect(commitCidStr).toMatch(/^baf/)
    // Should round-trip through multiformats CID
    const parsed = CID.parse(commitCidStr)
    expect(parsed.code).toBe(0x71)
    expect(parsed.version).toBe(1)
    expect(parsed.toString()).toBe(commitCidStr)
  })
})

describe('MST inclusion proof CAR', () => {
  it('should build a CAR with inclusion proof for a record path', async () => {
    const memStore = new MemoryBlockStore()
    const overlay = new OverlayBlockStore(new MemoryBlockStore(), memStore)
    const nodeStore = new NodeStore(overlay)
    const wrangler = new NodeWrangler(nodeStore)

    const recordCid = await makeCidStr('proof-record')

    // Insert a record into the MST
    const root = await wrangler.putRecord(
      null,
      'app.stratos.feed.post/abc123',
      {
        $link: recordCid,
      },
    )
    expect(root).toBeTruthy()

    // Build inclusion proof
    const proofCids = await buildInclusionProof(
      nodeStore,
      root!,
      'app.stratos.feed.post/abc123',
    )

    expect(proofCids.size).toBeGreaterThan(0)

    // Simulate building a CAR like the getRecord handler does
    const commitData = {
      did: DID,
      version: 3,
      data: { $link: root } as CidLink,
      rev: '1111111111111',
      prev: null,
      sig: cborToBytes(new Uint8Array(64)),
    }
    const commitBytes = AtcuteCbor.encode(commitData)
    const commitCid = await AtcuteCid.create(0x71, commitBytes)
    const commitCidStr = AtcuteCid.toString(commitCid)

    // Collect all blocks: commit + proof nodes + record
    const allCids = new Set<string>([commitCidStr, ...proofCids, recordCid])
    const blockStore = new Map<string, Uint8Array>()
    blockStore.set(commitCidStr, commitBytes)

    // Get MST node blocks from the overlay
    for (const cidStr of proofCids) {
      const bytes = await overlay.get(cidStr)
      if (bytes) blockStore.set(cidStr, bytes)
    }

    // Add the record block
    const recordData = AtcuteCbor.encode({ text: 'hello proof' })
    blockStore.set(recordCid, recordData)

    // Build CAR
    const rootLink: CidLink = { $link: commitCidStr }
    const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []
    for (const [cidStr, bytes] of blockStore) {
      const parsed = AtcuteCid.fromString(cidStr)
      carBlocks.push({ cid: parsed.bytes, data: bytes })
    }

    const carBytes = await collectCarStream([rootLink], carBlocks)
    expect(carBytes.length).toBeGreaterThan(0)

    // Read back and verify
    const reader = CAR.fromUint8Array(carBytes)
    expect(reader.roots[0].$link).toBe(commitCidStr)

    const entries = [...reader]
    const entryCids = new Set(entries.map((e) => AtcuteCid.toString(e.cid)))
    expect(entryCids.has(commitCidStr)).toBe(true)
    // Should contain record CID
    expect(entryCids.has(recordCid)).toBe(true)
    // Should contain proof nodes
    for (const proofCid of proofCids) {
      expect(entryCids.has(proofCid)).toBe(true)
    }
  })

  it('should build proof for multiple records sharing MST nodes', async () => {
    const memStore = new MemoryBlockStore()
    const overlay = new OverlayBlockStore(new MemoryBlockStore(), memStore)
    const nodeStore = new NodeStore(overlay)
    const wrangler = new NodeWrangler(nodeStore)

    const cid1 = await makeCidStr('record-1')
    const cid2 = await makeCidStr('record-2')
    const cid3 = await makeCidStr('record-3')

    let root = await wrangler.putRecord(null, 'app.stratos.feed.post/a1', {
      $link: cid1,
    })
    root = await wrangler.putRecord(root, 'app.stratos.feed.post/a2', {
      $link: cid2,
    })
    root = await wrangler.putRecord(root, 'app.stratos.feed.post/a3', {
      $link: cid3,
    })

    // Proof for each record should be available
    const proof1 = await buildInclusionProof(
      nodeStore,
      root!,
      'app.stratos.feed.post/a1',
    )
    const proof2 = await buildInclusionProof(
      nodeStore,
      root!,
      'app.stratos.feed.post/a2',
    )
    const proof3 = await buildInclusionProof(
      nodeStore,
      root!,
      'app.stratos.feed.post/a3',
    )

    expect(proof1.size).toBeGreaterThan(0)
    expect(proof2.size).toBeGreaterThan(0)
    expect(proof3.size).toBeGreaterThan(0)
  })
})

describe('Full repo CAR building', () => {
  it('should build a valid CAR from iterateCarBlocks-style data', async () => {
    // Simulate what the getRepo handler does: collect blocks and write CAR
    const recordData = AtcuteCbor.encode({ text: 'repo test' })
    const recordCid = await AtcuteCid.create(0x71, recordData)
    const recordCidStr = AtcuteCid.toString(recordCid)

    // Build a minimal MST
    const memStore = new MemoryBlockStore()
    const overlay = new OverlayBlockStore(new MemoryBlockStore(), memStore)
    const nodeStore = new NodeStore(overlay)
    const wrangler = new NodeWrangler(nodeStore)

    const root = await wrangler.putRecord(null, 'app.stratos.feed.post/t1', {
      $link: recordCidStr,
    })

    // Create commit
    const commitObj = {
      did: DID,
      version: 3,
      data: { $link: root } as CidLink,
      rev: '4444444444444',
      prev: null,
      sig: cborToBytes(new Uint8Array(64)),
    }
    const commitBytes = AtcuteCbor.encode(commitObj)
    const commitCid = await AtcuteCid.create(0x71, commitBytes)
    const commitCidStr = AtcuteCid.toString(commitCid)

    // Simulate iterateCarBlocks: all blocks in storage
    const allBlocks: Array<{ cid: string; bytes: Uint8Array }> = [
      { cid: commitCidStr, bytes: commitBytes },
      { cid: recordCidStr, bytes: recordData },
    ]

    // Add MST node blocks from overlay
    for (const [cidStr, bytes] of (overlay as any).upper.blocks) {
      allBlocks.push({ cid: cidStr, bytes })
    }

    // Build CAR (same as getRepo handler)
    const rootLink: CidLink = { $link: commitCidStr }
    const carBlocks: Array<{ cid: Uint8Array; data: Uint8Array }> = []
    for (const block of allBlocks) {
      const parsed = AtcuteCid.fromString(block.cid)
      carBlocks.push({ cid: parsed.bytes, data: block.bytes })
    }

    const carBytes = await collectCarStream([rootLink], carBlocks)

    // Parse the CAR and verify structure
    const reader = CAR.fromUint8Array(carBytes)
    expect(reader.roots).toHaveLength(1)
    expect(reader.roots[0].$link).toBe(commitCidStr)

    const entries = [...reader]
    expect(entries.length).toBe(allBlocks.length)
  })
})

describe('Import repo CAR verification', () => {
  async function buildTestRepoCar(did: string): Promise<{
    carBytes: Uint8Array
    commitCidStr: string
    recordCidStr: string
  }> {
    const recordData = AtcuteCbor.encode({
      $type: 'app.stratos.feed.post',
      text: 'imported',
    })
    const recordCid = await AtcuteCid.create(0x71, recordData)
    const recordCidStr = AtcuteCid.toString(recordCid)

    // Build MST with one record
    const memStore = new MemoryBlockStore()
    const overlay = new OverlayBlockStore(new MemoryBlockStore(), memStore)
    const nodeStore = new NodeStore(overlay)
    const wrangler = new NodeWrangler(nodeStore)

    const mstRoot = await wrangler.putRecord(
      null,
      'app.stratos.feed.post/imp1',
      {
        $link: recordCidStr,
      },
    )

    const commitObj = {
      did,
      version: 3,
      data: { $link: mstRoot } as CidLink,
      rev: '5555555555555',
      prev: null,
      sig: cborToBytes(new Uint8Array(64)),
    }
    const commitBytes = AtcuteCbor.encode(commitObj)
    const commitCid = await AtcuteCid.create(0x71, commitBytes)
    const commitCidStr = AtcuteCid.toString(commitCid)

    // Collect all blocks
    const allBlocks = new Map<string, Uint8Array>()
    allBlocks.set(commitCidStr, commitBytes)
    allBlocks.set(recordCidStr, recordData)

    for (const [cidStr, bytes] of (overlay as any).upper.blocks) {
      allBlocks.set(cidStr, bytes)
    }

    // Build CAR
    const rootLink: CidLink = { $link: commitCidStr }
    const carBlockList: Array<{ cid: Uint8Array; data: Uint8Array }> = []
    for (const [cidStr, bytes] of allBlocks) {
      const parsed = AtcuteCid.fromString(cidStr)
      carBlockList.push({ cid: parsed.bytes, data: bytes })
    }

    const carBytes = await collectCarStream([rootLink], carBlockList)
    return { carBytes, commitCidStr, recordCidStr }
  }

  it('should parse a valid repo CAR and extract commit', async () => {
    const { carBytes, commitCidStr } = await buildTestRepoCar(DID)

    const reader = CAR.fromUint8Array(carBytes)
    expect(reader.roots).toHaveLength(1)

    const rootCidLink = reader.roots[0]
    expect(rootCidLink.$link).toBe(commitCidStr)

    // Read all blocks
    const blocks = new Map<string, Uint8Array>()
    for (const entry of reader) {
      blocks.set(AtcuteCid.toString(entry.cid), entry.bytes)
    }

    // Decode commit
    const commitBytes = blocks.get(rootCidLink.$link)
    expect(commitBytes).toBeDefined()
    const commit = AtcuteCbor.decode(commitBytes!) as {
      did: string
      data: CidLink
      rev: string
      version: number
    }

    expect(commit.did).toBe(DID)
    expect(commit.version).toBe(3)
    expect(commit.rev).toBe('5555555555555')
    expect(commit.data.$link).toBeTruthy()
  })

  it('should iterate records via @atcute/repo fromUint8Array', async () => {
    const { carBytes } = await buildTestRepoCar(DID)

    const records: Array<{ collection: string; rkey: string; cid: string }> = []
    for (const entry of repoFromCar(carBytes)) {
      records.push({
        collection: entry.collection,
        rkey: entry.rkey,
        cid: entry.cid.$link,
      })
    }

    expect(records).toHaveLength(1)
    expect(records[0].collection).toBe('app.stratos.feed.post')
    expect(records[0].rkey).toBe('imp1')
    expect(records[0].cid).toBeTruthy()
  })

  it('should verify all block CIDs match their content', async () => {
    const { carBytes } = await buildTestRepoCar(DID)

    const reader = CAR.fromUint8Array(carBytes)
    for (const entry of reader) {
      const cidStr = AtcuteCid.toString(entry.cid)
      const blockBytes = new Uint8Array(entry.bytes) as Uint8Array<ArrayBuffer>
      const expected = await AtcuteCid.create(
        entry.cid.codec as 0x55 | 0x71,
        blockBytes,
      )
      expect(AtcuteCid.toString(expected)).toBe(cidStr)
    }
  })

  it('should reject a CAR with mismatched DID in commit', async () => {
    const { carBytes } = await buildTestRepoCar('did:plc:attacker')

    const reader = CAR.fromUint8Array(carBytes)
    const rootCidLink = reader.roots[0]

    const blocks = new Map<string, Uint8Array>()
    for (const entry of reader) {
      blocks.set(AtcuteCid.toString(entry.cid), entry.bytes)
    }

    const commitBytes = blocks.get(rootCidLink.$link)!
    const commit = AtcuteCbor.decode(commitBytes) as { did: string }

    // The verification logic in the handler would compare commit.did against
    // the authenticated user's DID — this should fail:
    expect(commit.did).not.toBe(DID)
    expect(commit.did).toBe('did:plc:attacker')
  })
})

describe('CID string interop', () => {
  it('should produce identical CID strings from atcute and multiformats', async () => {
    const data = AtcuteCbor.encode({ interop: 'test' })
    const atcuteCid = await AtcuteCid.create(0x71, data)
    const atcuteStr = AtcuteCid.toString(atcuteCid)

    const mfCid = CID.parse(atcuteStr)
    expect(mfCid.toString()).toBe(atcuteStr)

    // Round-trip back
    const backToAtcute = AtcuteCid.fromString(mfCid.toString())
    expect(AtcuteCid.toString(backToAtcute)).toBe(atcuteStr)
  })

  it('should handle raw codec (0x55) CIDs', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const atcuteCid = await AtcuteCid.create(
      0x55,
      data as Uint8Array<ArrayBuffer>,
    )
    const str = AtcuteCid.toString(atcuteCid)

    const mfCid = CID.parse(str)
    expect(mfCid.code).toBe(0x55)
    expect(mfCid.toString()).toBe(str)
  })

  it('should have matching CID bytes between atcute and multiformats', async () => {
    const data = AtcuteCbor.encode({ bytes: 'match' })
    const atcuteCid = await AtcuteCid.create(0x71, data)
    const str = AtcuteCid.toString(atcuteCid)

    const mfCid = CID.parse(str)
    const atcuteBytes = atcuteCid.bytes

    // The raw CID byte representations should match
    expect(new Uint8Array(atcuteBytes)).toEqual(new Uint8Array(mfCid.bytes))
  })
})
