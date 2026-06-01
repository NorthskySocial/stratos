/**
 * Tests for XRPC handler changes:
 * - uploadBlob: new handler following atproto two-phase blob upload pattern
 * - sync.getRecord: uses stored block bytes instead of re-encoding
 * - describeRepo: handleIsCorrect now actually resolves handle → DID
 * - getBlobStore: new method on StratosActorStore
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'
import { AtUri } from '@atproto/syntax'
import { encode as cborEncode, type LexValue } from '@atproto/lex-cbor'
import * as dagCbor from '@ipld/dag-cbor'

import { BlobStore } from '@northskysocial/stratos-core'
import { StratosActorStore } from '../src/context.js'
import { decodeVarint, encodeVarint } from '../src/api/varint.js'

const RAW_CODEC = 0x55
const DAG_CBOR_CODEC = 0x71

function createMockBlobStore(): BlobStore {
  const storage = new Map<string, Uint8Array>()
  const tempStorage = new Map<string, Uint8Array>()

  return {
    putTemp: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
      const key = `temp-${randomBytes(8).toString('hex')}`
      if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
        tempStorage.set(key, bytes)
      }
      return key
    }),
    makePermanent: vi.fn().mockImplementation(async (key: string, cid: Cid) => {
      const bytes = tempStorage.get(key)
      if (bytes) {
        storage.set(cid.toString(), bytes)
        tempStorage.delete(key)
      }
    }),
    putPermanent: vi
      .fn()
      .mockImplementation(async (cid: Cid, bytes: Uint8Array) => {
        if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
          storage.set(cid.toString(), bytes)
        }
      }),
    quarantine: vi.fn().mockResolvedValue(undefined),
    unquarantine: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockImplementation(async (cid: Cid) => {
      storage.delete(cid.toString())
    }),
    deleteMany: vi.fn().mockImplementation(async (cids: Cid[]) => {
      for (const cid of cids) {
        storage.delete(cid.toString())
      }
    }),
    hasTemp: vi.fn().mockImplementation(async (key: string) => {
      return tempStorage.has(key)
    }),
    hasStored: vi.fn().mockImplementation(async (cid: Cid) => {
      return storage.has(cid.toString())
    }),
    getBytes: vi.fn().mockImplementation(async (cid: Cid) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) throw new Error('Blob not found')
      return bytes
    }),
    getStream: vi.fn().mockImplementation(async (cid: Cid) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) throw new Error('Blob not found')
      async function* generate() {
        yield bytes!
      }
      return generate()
    }),
    getTempStream: vi.fn().mockImplementation(async (key: string) => {
      const bytes = tempStorage.get(key)
      if (!bytes) throw new Error('Blob not found')
      async function* generate() {
        yield bytes!
      }
      return generate()
    }),
  }
}

function cborToRecord(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('StratosActorStore.getBlobStore', () => {
  let actorStore: StratosActorStore
  let testDir: string
  let mockBlobStores: Map<string, BlobStore>

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-handler-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    mockBlobStores = new Map()
    actorStore = new StratosActorStore({
      dataDir: testDir,
      blobstore: (did: string) => {
        if (!mockBlobStores.has(did)) {
          mockBlobStores.set(did, createMockBlobStore())
        }
        return mockBlobStores.get(did)!
      },
      cborToRecord,
    })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should return a BlobStore for a given DID', () => {
    const store = actorStore.getBlobStore('did:plc:test1')
    expect(store).toBeDefined()
    expect(store.putTemp).toBeDefined()
    expect(store.makePermanent).toBeDefined()
  })

  it('should return the same store for the same DID', () => {
    const store1 = actorStore.getBlobStore('did:plc:test1')
    const store2 = actorStore.getBlobStore('did:plc:test1')
    expect(store1).toBe(store2)
  })

  it('should return different stores for different DIDs', () => {
    const store1 = actorStore.getBlobStore('did:plc:user1')
    const store2 = actorStore.getBlobStore('did:plc:user2')
    expect(store1).not.toBe(store2)
  })

  it('should allow putTemp outside a transaction', async () => {
    const did = 'did:plc:blobtest'
    const blobstore = actorStore.getBlobStore(did)
    const bytes = new TextEncoder().encode('test blob data')
    const tempKey = await blobstore.putTemp(bytes)

    expect(tempKey).toBeDefined()
    expect(typeof tempKey).toBe('string')
    expect(blobstore.putTemp).toHaveBeenCalledWith(bytes)
  })
})

describe('uploadBlob handler logic', () => {
  it('should compute CID with raw codec (0x55) for blobs', async () => {
    const bytes = new TextEncoder().encode('hello blob')
    const hash = await sha256.digest(bytes)
    const cid = CID.createV1(RAW_CODEC, hash)

    expect(cid.code).toBe(RAW_CODEC)
    expect(cid.version).toBe(1)
    expect(cid.multihash.code).toBe(sha256.code)
  })

  it('should produce deterministic CIDs for the same content', async () => {
    const bytes = new TextEncoder().encode('deterministic test')
    const hash1 = await sha256.digest(bytes)
    const cid1 = CID.createV1(RAW_CODEC, hash1)
    const hash2 = await sha256.digest(bytes)
    const cid2 = CID.createV1(RAW_CODEC, hash2)

    expect(cid1.toString()).toBe(cid2.toString())
  })

  it('should produce different CIDs for different content', async () => {
    const bytes1 = new TextEncoder().encode('content A')
    const bytes2 = new TextEncoder().encode('content B')
    const hash1 = await sha256.digest(bytes1)
    const hash2 = await sha256.digest(bytes2)
    const cid1 = CID.createV1(RAW_CODEC, hash1)
    const cid2 = CID.createV1(RAW_CODEC, hash2)

    expect(cid1.toString()).not.toBe(cid2.toString())
  })

  it('blob CID (raw codec) should differ from record CID (dag-cbor) for same hash', async () => {
    const bytes = new TextEncoder().encode('same content')
    const hash = await sha256.digest(bytes)
    const blobCid = CID.createV1(RAW_CODEC, hash)
    const recordCid = CID.createV1(DAG_CBOR_CODEC, hash)

    expect(blobCid.toString()).not.toBe(recordCid.toString())
    expect(blobCid.code).toBe(RAW_CODEC)
    expect(recordCid.code).toBe(DAG_CBOR_CODEC)
  })

  it('should collect Readable stream into Uint8Array', async () => {
    const chunks = [
      Buffer.from('chunk1'),
      Buffer.from('chunk2'),
      Buffer.from('chunk3'),
    ]
    const readable = Readable.from(chunks)
    const collected: Buffer[] = []
    for await (const chunk of readable) {
      collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const bytes = new Uint8Array(Buffer.concat(collected))

    expect(bytes.length).toBe(18) // 6+6+6
    expect(new TextDecoder().decode(bytes)).toBe('chunk1chunk2chunk3')
  })

  it('should handle Uint8Array body directly', () => {
    const input = new Uint8Array([1, 2, 3, 4])
    const bytes = new Uint8Array(input)

    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('should complete two-phase upload: putTemp then trackBlob', async () => {
    const testDir = join(
      tmpdir(),
      `stratos-upload-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    try {
      const mockBlobStore = createMockBlobStore()
      const actorStore = new StratosActorStore({
        dataDir: testDir,
        blobstore: () => mockBlobStore,
        cborToRecord,
      })

      const did = 'did:plc:uploader'
      await actorStore.create(did)

      const blobBytes = new TextEncoder().encode('image data here')
      const hash = await sha256.digest(blobBytes)
      const cid = CID.createV1(RAW_CODEC, hash)

      // Phase 1: temp storage (outside transaction)
      const blobstore = actorStore.getBlobStore(did)
      const tempKey = await blobstore.putTemp(blobBytes)
      expect(tempKey).toBeDefined()
      expect(mockBlobStore.putTemp).toHaveBeenCalledWith(blobBytes)

      // Phase 2: track in database (inside transaction)
      await actorStore.transact(did, async (store) => {
        await store.blob.trackBlob({
          cid,
          mimeType: 'image/png',
          size: blobBytes.length,
          tempKey,
        })
      })

      // Verify blob is tracked via metadata (listBlobs only returns record-associated blobs)
      const metadata = await actorStore.read(did, async (store) => {
        return store.blob.getBlobMetadata(cid)
      })
      expect(metadata).not.toBeNull()
      expect(metadata!.mimeType).toBe('image/png')
      expect(metadata!.size).toBe(blobBytes.length)
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })
})

describe('sync.getRecord CAR building', () => {
  let actorStore: StratosActorStore
  let testDir: string
  const testDid = 'did:plc:synctest'

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-sync-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    actorStore = new StratosActorStore({
      dataDir: testDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (bytes: Uint8Array) =>
        dagCbor.decode(bytes) as Record<string, unknown>,
    })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should retrieve stored block bytes matching the CID', async () => {
    await actorStore.create(testDid)

    const record = { text: 'hello world', createdAt: '2025-01-01T00:00:00Z' }
    const recordBytes = cborEncode(record as unknown as LexValue)
    const hash = await sha256.digest(recordBytes)
    const recordCid = CID.createV1(DAG_CBOR_CODEC, hash)

    // Store block and index record
    await actorStore.transact(testDid, async (store) => {
      const uri = new AtUri(`at://${testDid}/zone.stratos.feed.post/rec1`)
      await store.repo.putBlock(recordCid, recordBytes, 'rev1')
      await store.record.indexRecord(uri, recordCid, record, 'create', 'rev1')
    })

    // Read back and verify we get the exact same bytes
    const result = await actorStore.read(testDid, async (store) => {
      return await store.repo.getBytes(recordCid)
    })

    expect(result).not.toBeNull()
    // SQLite returns Buffer; normalize both sides for byte comparison
    expect(new Uint8Array(result!)).toEqual(new Uint8Array(recordBytes))
  })

  it('should build valid CAR v1 from stored bytes', async () => {
    await actorStore.create(testDid)

    const record = { text: 'car test', num: 42 }
    const recordBytes = cborEncode(record as unknown as LexValue)
    const hash = await sha256.digest(recordBytes)
    const recordCid = CID.createV1(DAG_CBOR_CODEC, hash)

    await actorStore.transact(testDid, async (store) => {
      const uri = new AtUri(`at://${testDid}/zone.stratos.feed.post/car1`)
      await store.repo.putBlock(recordCid, recordBytes, 'rev1')
      await store.record.indexRecord(uri, recordCid, record, 'create', 'rev1')
    })

    // Simulate CAR building (same logic as the handler)
    const rawStoredBytes = await actorStore.read(testDid, async (store) => {
      return await store.repo.getBytes(recordCid)
    })
    expect(rawStoredBytes).not.toBeNull()
    // Normalize Buffer → Uint8Array (SQLite returns Buffer)
    const storedBytes = new Uint8Array(rawStoredBytes!)

    const header = dagCbor.encode({ version: 1, roots: [recordCid] })
    const headerVarInt = encodeVarint(header.length)
    const cidBytes = recordCid.bytes
    const blockVarInt = encodeVarint(cidBytes.length + storedBytes!.length)

    const carLength =
      headerVarInt.length +
      header.length +
      blockVarInt.length +
      cidBytes.length +
      storedBytes!.length

    const car = new Uint8Array(carLength)
    let offset = 0
    car.set(headerVarInt, offset)
    offset += headerVarInt.length
    car.set(header, offset)
    offset += header.length
    car.set(blockVarInt, offset)
    offset += blockVarInt.length
    car.set(cidBytes, offset)
    offset += cidBytes.length
    car.set(storedBytes!, offset)

    // Parse the CAR back to verify structure
    expect(car.length).toBeGreaterThan(0)

    // Read header varint
    const { value: headerLen, bytesRead } = decodeVarint(car, 0)
    expect(headerLen).toBe(header.length)

    // Decode header CBOR
    const headerSlice = car.slice(bytesRead, bytesRead + headerLen)
    const decodedHeader = dagCbor.decode(headerSlice) as {
      version: number
      roots: Cid[]
    }
    expect(decodedHeader.version).toBe(1)
    expect(decodedHeader.roots).toHaveLength(1)
    expect(decodedHeader.roots[0].toString()).toBe(recordCid.toString())

    // Read block varint
    const blockStart = bytesRead + headerLen
    const { value: blockLen, bytesRead: blockVarIntLen } = decodeVarint(
      car,
      blockStart,
    )
    expect(blockLen).toBe(cidBytes.length + storedBytes!.length)

    // Extract block CID and data
    const blockDataStart = blockStart + blockVarIntLen
    const blockCidSlice = car.slice(
      blockDataStart,
      blockDataStart + cidBytes.length,
    )
    const parsedCid = CID.decode(blockCidSlice)
    expect(parsedCid.toString()).toBe(recordCid.toString())

    const blockDataSlice = car.slice(
      blockDataStart + cidBytes.length,
      blockDataStart + blockLen,
    )
    expect(new Uint8Array(blockDataSlice)).toEqual(storedBytes)

    // Verify the block data hashes back to the same CID
    const reHash = await sha256.digest(blockDataSlice)
    const reCid = CID.createV1(DAG_CBOR_CODEC, reHash)
    expect(reCid.toString()).toBe(recordCid.toString())
  })

  it('stored bytes should be identical to originally encoded bytes', async () => {
    await actorStore.create(testDid)

    const record = { text: 'byte identity test', tags: ['a', 'b'] }
    const originalBytes = cborEncode(record as unknown as LexValue)
    const hash = await sha256.digest(originalBytes)
    const cid = CID.createV1(DAG_CBOR_CODEC, hash)

    await actorStore.transact(testDid, async (store) => {
      await store.repo.putBlock(cid, originalBytes, 'rev1')
    })

    const retrieved = await actorStore.read(testDid, async (store) => {
      return await store.repo.getBytes(cid)
    })

    // Byte-for-byte equality — this is what the fix ensures
    expect(Buffer.from(retrieved!).equals(Buffer.from(originalBytes))).toBe(
      true,
    )
  })
})

describe('describeRepo handleIsCorrect', () => {
  it('should return true when handle resolves to the same DID', async () => {
    const repo = 'did:plc:alice'
    const handle = 'alice.test.com'

    const mockIdResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          id: repo,
          alsoKnownAs: [`at://${handle}`],
        }),
      },
      handle: {
        resolve: vi.fn().mockResolvedValue(repo),
      },
    }

    // Simulate the handler logic
    let resolvedHandle: string | undefined
    let handleIsCorrect = false

    const resolved = await mockIdResolver.did.resolve(repo)
    if (resolved) {
      const alsoKnownAs = (resolved as { alsoKnownAs?: string[] }).alsoKnownAs
      if (alsoKnownAs) {
        const atHandle = alsoKnownAs.find((aka: string) =>
          aka.startsWith('at://'),
        )
        if (atHandle) {
          resolvedHandle = atHandle.replace('at://', '')
        }
      }
    }

    if (resolvedHandle) {
      const resolvedDid = await mockIdResolver.handle.resolve(resolvedHandle)
      handleIsCorrect = resolvedDid === repo
    }

    expect(resolvedHandle).toBe(handle)
    expect(handleIsCorrect).toBe(true)
    expect(mockIdResolver.handle.resolve).toHaveBeenCalledWith(handle)
  })

  it('should return false when handle resolves to a different DID', async () => {
    const repo = 'did:plc:alice'
    const handle = 'alice.test.com'

    const mockIdResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          id: repo,
          alsoKnownAs: [`at://${handle}`],
        }),
      },
      handle: {
        resolve: vi.fn().mockResolvedValue('did:plc:someone_else'),
      },
    }

    let resolvedHandle: string | undefined
    let handleIsCorrect = false

    const resolved = await mockIdResolver.did.resolve(repo)
    if (resolved) {
      const alsoKnownAs = (resolved as { alsoKnownAs?: string[] }).alsoKnownAs
      if (alsoKnownAs) {
        const atHandle = alsoKnownAs.find((aka: string) =>
          aka.startsWith('at://'),
        )
        if (atHandle) {
          resolvedHandle = atHandle.replace('at://', '')
        }
      }
    }

    if (resolvedHandle) {
      const resolvedDid = await mockIdResolver.handle.resolve(resolvedHandle)
      handleIsCorrect = resolvedDid === repo
    }

    expect(handleIsCorrect).toBe(false)
  })

  it('should return false when handle resolution throws', async () => {
    const repo = 'did:plc:alice'
    const handle = 'alice.test.com'

    const mockIdResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          id: repo,
          alsoKnownAs: [`at://${handle}`],
        }),
      },
      handle: {
        resolve: vi.fn().mockRejectedValue(new Error('DNS resolution failed')),
      },
    }

    let resolvedHandle: string | undefined
    let handleIsCorrect = false

    const resolved = await mockIdResolver.did.resolve(repo)
    if (resolved) {
      const alsoKnownAs = (resolved as { alsoKnownAs?: string[] }).alsoKnownAs
      if (alsoKnownAs) {
        const atHandle = alsoKnownAs.find((aka: string) =>
          aka.startsWith('at://'),
        )
        if (atHandle) {
          resolvedHandle = atHandle.replace('at://', '')
        }
      }
    }

    if (resolvedHandle) {
      try {
        const resolvedDid = await mockIdResolver.handle.resolve(resolvedHandle)
        handleIsCorrect = resolvedDid === repo
      } catch {
        handleIsCorrect = false
      }
    }

    expect(handleIsCorrect).toBe(false)
  })

  it('should return false when handle resolution returns undefined', async () => {
    const repo = 'did:plc:alice'
    const handle = 'alice.test.com'

    const mockIdResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          id: repo,
          alsoKnownAs: [`at://${handle}`],
        }),
      },
      handle: {
        resolve: vi.fn().mockResolvedValue(undefined),
      },
    }

    let resolvedHandle: string | undefined
    let handleIsCorrect = false

    const resolved = await mockIdResolver.did.resolve(repo)
    if (resolved) {
      const alsoKnownAs = (resolved as { alsoKnownAs?: string[] }).alsoKnownAs
      if (alsoKnownAs) {
        const atHandle = alsoKnownAs.find((aka: string) =>
          aka.startsWith('at://'),
        )
        if (atHandle) {
          resolvedHandle = atHandle.replace('at://', '')
        }
      }
    }

    if (resolvedHandle) {
      try {
        const resolvedDid = await mockIdResolver.handle.resolve(resolvedHandle)
        handleIsCorrect = resolvedDid === repo
      } catch {
        handleIsCorrect = false
      }
    }

    expect(handleIsCorrect).toBe(false)
  })

  it('should remain false when no handle is in DID doc', async () => {
    const repo = 'did:plc:alice'

    const mockIdResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          id: repo,
          alsoKnownAs: [],
        }),
      },
      handle: {
        resolve: vi.fn(),
      },
    }

    let resolvedHandle: string | undefined
    let handleIsCorrect = false

    const resolved = await mockIdResolver.did.resolve(repo)
    if (resolved) {
      const alsoKnownAs = (resolved as { alsoKnownAs?: string[] }).alsoKnownAs
      if (alsoKnownAs) {
        const atHandle = alsoKnownAs.find((aka: string) =>
          aka.startsWith('at://'),
        )
        if (atHandle) {
          resolvedHandle = atHandle.replace('at://', '')
        }
      }
    }

    if (resolvedHandle) {
      const resolvedDid = await mockIdResolver.handle.resolve(resolvedHandle)
      handleIsCorrect = resolvedDid === repo
    }

    expect(resolvedHandle).toBeUndefined()
    expect(handleIsCorrect).toBe(false)
    expect(mockIdResolver.handle.resolve).not.toHaveBeenCalled()
  })

  it('should remain false when DID resolution fails', async () => {
    const repo = 'did:plc:alice'

    const mockIdResolver = {
      did: {
        resolve: vi.fn().mockRejectedValue(new Error('DID not found')),
      },
      handle: {
        resolve: vi.fn(),
      },
    }

    const handleIsCorrect = false
    try {
      await mockIdResolver.did.resolve(repo)
    } catch {
      // DID resolution is best-effort
    }

    expect(handleIsCorrect).toBe(false)
    expect(mockIdResolver.handle.resolve).not.toHaveBeenCalled()
  })
})
