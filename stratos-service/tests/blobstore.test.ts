/**
 * Tests for blob storage adapters (DiskBlobStore, S3BlobStoreAdapter)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'

import { DiskBlobStore } from '../src/index.js'
import {
  asyncIterableToReadable,
  collectAsyncIterable,
  readableToAsyncIterable,
} from '../src/infra/blobstore/index.js'

// Create a deterministic CID from data
const createCid = async (data: string | Uint8Array): Promise<CID> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

describe('DiskBlobStore', () => {
  let testDir: string
  let store: DiskBlobStore
  const testDid = 'did:plc:blobtest123'

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-blobstore-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    // Create store using a factory pattern
    const creator = DiskBlobStore.creator(
      join(testDir, 'blobs'),
      join(testDir, 'blobs', 'temp'),
      join(testDir, 'blobs', 'quarantine'),
    )
    store = creator(testDid) as DiskBlobStore
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('factory pattern', () => {
    it('should create per-DID blob stores', () => {
      const creator = DiskBlobStore.creator(join(testDir, 'blobs'))

      const store1 = creator('did:plc:user1')
      const store2 = creator('did:plc:user2')

      expect(store1).toBeInstanceOf(DiskBlobStore)
      expect(store2).toBeInstanceOf(DiskBlobStore)
      expect((store1 as DiskBlobStore).did).toBe('did:plc:user1')
      expect((store2 as DiskBlobStore).did).toBe('did:plc:user2')
    })
  })

  describe('putTemp', () => {
    it('should store bytes temporarily and return key', async () => {
      const bytes = new TextEncoder().encode('test blob content')
      const key = await store.putTemp(bytes)

      expect(key).toBeDefined()
      expect(typeof key).toBe('string')
      expect(key.length).toBeGreaterThan(0)

      // Verify file exists
      const hasTemp = await store.hasTemp(key)
      expect(hasTemp).toBe(true)
    })

    it('should handle async iterable input', async () => {
      async function* generateChunks() {
        yield new TextEncoder().encode('chunk1')
        yield new TextEncoder().encode('chunk2')
      }

      const key = await store.putTemp(generateChunks())
      expect(key).toBeDefined()
      expect(await store.hasTemp(key)).toBe(true)
    })
  })

  describe('makePermanent', () => {
    it('should move temp blob to permanent storage', async () => {
      const content = new TextEncoder().encode('permanent content')
      const cid = await createCid(content)
      const key = await store.putTemp(content)

      expect(await store.hasTemp(key)).toBe(true)
      expect(await store.hasStored(cid)).toBe(false)

      await store.makePermanent(key, cid)

      expect(await store.hasTemp(key)).toBe(false)
      expect(await store.hasStored(cid)).toBe(true)
    })
  })

  describe('putPermanent', () => {
    it('should store bytes directly as permanent', async () => {
      const content = new TextEncoder().encode('direct permanent')
      const cid = await createCid(content)

      await store.putPermanent(cid, content)

      expect(await store.hasStored(cid)).toBe(true)
      const retrieved = await store.getBytes(cid)
      expect(retrieved).toEqual(content)
    })

    it('should handle async iterable input', async () => {
      const content = 'iterable permanent content'
      const cid = await createCid(content)

      async function* generateContent() {
        yield new TextEncoder().encode(content)
      }

      await store.putPermanent(cid, generateContent())

      expect(await store.hasStored(cid)).toBe(true)
      const retrieved = await store.getBytes(cid)
      expect(new TextDecoder().decode(retrieved)).toBe(content)
    })
  })

  describe('getBytes', () => {
    it('should retrieve stored blob bytes', async () => {
      const content = new TextEncoder().encode('retrievable content')
      const cid = await createCid(content)
      await store.putPermanent(cid, content)

      const retrieved = await store.getBytes(cid)
      expect(retrieved).toEqual(content)
    })

    it('should throw BlobNotFoundError for missing blob', async () => {
      const cid = await createCid('nonexistent')
      await expect(store.getBytes(cid)).rejects.toThrow('Blob not found')
    })
  })

  describe('getStream', () => {
    it('should return async iterable of blob bytes', async () => {
      const content = new TextEncoder().encode('streamable content')
      const cid = await createCid(content)
      await store.putPermanent(cid, content)

      const stream = await store.getStream(cid)
      const collected = await collectAsyncIterable(stream)
      expect(collected).toEqual(content)
    })
  })

  describe('quarantine/unquarantine', () => {
    it('should move blob to quarantine', async () => {
      const content = new TextEncoder().encode('to be quarantined')
      const cid = await createCid(content)
      await store.putPermanent(cid, content)

      expect(await store.hasStored(cid)).toBe(true)
      await store.quarantine(cid)
      expect(await store.hasStored(cid)).toBe(false)
    })

    it('should restore blob from quarantine', async () => {
      const content = new TextEncoder().encode('to be restored')
      const cid = await createCid(content)
      await store.putPermanent(cid, content)

      await store.quarantine(cid)
      expect(await store.hasStored(cid)).toBe(false)

      await store.unquarantine(cid)
      expect(await store.hasStored(cid)).toBe(true)

      const retrieved = await store.getBytes(cid)
      expect(retrieved).toEqual(content)
    })
  })

  describe('delete/deleteMany', () => {
    it('should delete a blob', async () => {
      const content = new TextEncoder().encode('to be deleted')
      const cid = await createCid(content)
      await store.putPermanent(cid, content)

      expect(await store.hasStored(cid)).toBe(true)
      await store.delete(cid)
      expect(await store.hasStored(cid)).toBe(false)
    })

    it('should delete multiple blobs', async () => {
      const cid1 = await createCid('blob1')
      const cid2 = await createCid('blob2')
      const cid3 = await createCid('blob3')

      await store.putPermanent(cid1, new TextEncoder().encode('blob1'))
      await store.putPermanent(cid2, new TextEncoder().encode('blob2'))
      await store.putPermanent(cid3, new TextEncoder().encode('blob3'))

      await store.deleteMany([cid1, cid2])

      expect(await store.hasStored(cid1)).toBe(false)
      expect(await store.hasStored(cid2)).toBe(false)
      expect(await store.hasStored(cid3)).toBe(true)
    })
  })
})

describe('Stream Utilities', () => {
  describe('collectAsyncIterable', () => {
    it('should collect chunks into single Uint8Array', async () => {
      async function* generate() {
        yield new Uint8Array([1, 2, 3])
        yield new Uint8Array([4, 5])
        yield new Uint8Array([6, 7, 8, 9])
      }

      const result = await collectAsyncIterable(generate())
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    })
  })

  describe('readableToAsyncIterable', () => {
    it('should convert Readable to AsyncIterable', async () => {
      const { Readable } = await import('stream')
      const readable = Readable.from([
        Buffer.from([1, 2, 3]),
        Buffer.from([4, 5, 6]),
      ])

      const chunks: Uint8Array[] = []
      for await (const chunk of readableToAsyncIterable(readable)) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(2)
      expect(chunks[0]).toEqual(new Uint8Array([1, 2, 3]))
      expect(chunks[1]).toEqual(new Uint8Array([4, 5, 6]))
    })
  })

  describe('asyncIterableToReadable', () => {
    it('should convert AsyncIterable to Readable', async () => {
      async function* generate() {
        yield new Uint8Array([1, 2])
        yield new Uint8Array([3, 4])
      }

      const readable = asyncIterableToReadable(generate())
      const chunks: Buffer[] = []

      for await (const chunk of readable) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(2)
    })
  })
})
