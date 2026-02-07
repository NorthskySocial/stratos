import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

import { StratosBlobReader, StratosBlobTransactor } from '../src/blob/index.js'
import {
  createStratosDb,
  migrateStratosDb,
  closeStratosDb,
  StratosDb,
  stratosBlob,
  stratosRecordBlob,
  stratosRecord,
} from '../src/db/index.js'
import { BlobStore } from '../src/types.js'

// Create a deterministic CID from data
const createCid = async (data: string | Buffer): Promise<CID> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

// Mock blob store
function createMockBlobStore(): BlobStore {
  const storage = new Map<string, Buffer>()

  return {
    putTemp: vi.fn().mockImplementation(async (bytes: Buffer) => {
      const key = `temp-${randomBytes(8).toString('hex')}`
      storage.set(key, bytes)
      return key
    }),
    makePermanent: vi.fn().mockImplementation(async (key: string, cid: CID) => {
      const bytes = storage.get(key)
      if (bytes) {
        storage.set(cid.toString(), bytes)
        storage.delete(key)
      }
    }),
    putPermanent: vi.fn().mockImplementation(async (cid: CID, bytes: Buffer | Readable) => {
      if (bytes instanceof Buffer) {
        storage.set(cid.toString(), bytes)
      } else {
        const chunks: Buffer[] = []
        for await (const chunk of bytes) {
          chunks.push(chunk)
        }
        const total = new Buffer(chunks.reduce((sum, c) => sum + c.length, 0))
        let offset = 0
        for (const chunk of chunks) {
          total.set(chunk, offset)
          offset += chunk.length
        }
        storage.set(cid.toString(), total)
      }
    }),
    quarantine: vi.fn().mockResolvedValue(undefined),
    unquarantine: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockImplementation(async (cid: CID) => {
      storage.delete(cid.toString())
    }),
    deleteMany: vi.fn().mockImplementation(async (cids: CID[]) => {
      for (const cid of cids) {
        storage.delete(cid.toString())
      }
    }),
    hasTemp: vi.fn().mockImplementation(async (key: string) => {
      return storage.has(key)
    }),
    hasStored: vi.fn().mockImplementation(async (cid: CID) => {
      return storage.has(cid.toString())
    }),
    getBytes: vi.fn().mockImplementation(async (cid: CID) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) throw new Error('Blob not found')
      return bytes
    }),
    getStream: vi.fn().mockImplementation(async (cid: CID) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) throw new Error('Blob not found')
      async function* generate() {
        yield bytes
      }
      return generate()
    }),
  }
}

describe('Blob Reader', () => {
  let db: StratosDb
  let blobStore: BlobStore
  let reader: StratosBlobReader
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-blob-test-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    blobStore = createMockBlobStore()
    reader = new StratosBlobReader(db, blobStore)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  describe('getBlobMetadata', () => {
    it('should return null for non-existent blob', async () => {
      const cid = await createCid('nonexistent')
      const result = await reader.getBlobMetadata(cid)
      expect(result).toBeNull()
    })

    it('should return metadata for existing blob', async () => {
      const cid = await createCid('test blob content')
      const now = new Date().toISOString()

      await db.insert(stratosBlob).values({
        cid: cid.toString(),
        mimeType: 'image/png',
        size: 12345,
        tempKey: null,
        width: 100,
        height: 200,
        createdAt: now,
        takedownRef: null,
      })

      const result = await reader.getBlobMetadata(cid)
      expect(result).not.toBeNull()
      expect(result?.size).toBe(12345)
      expect(result?.mimeType).toBe('image/png')
    })

    it('should not return metadata for taken-down blob', async () => {
      const cid = await createCid('taken down blob')
      const now = new Date().toISOString()

      await db.insert(stratosBlob).values({
        cid: cid.toString(),
        mimeType: 'image/jpeg',
        size: 5000,
        tempKey: null,
        width: null,
        height: null,
        createdAt: now,
        takedownRef: 'TAKEDOWN-001',
      })

      const result = await reader.getBlobMetadata(cid)
      expect(result).toBeNull()
    })
  })

  describe('hasBlob', () => {
    it('should return false for non-existent blob', async () => {
      const cid = await createCid('nonexistent')
      const result = await reader.hasBlob(cid)
      expect(result).toBe(false)
    })

    it('should return true for existing blob', async () => {
      const cid = await createCid('existing blob')
      await db.insert(stratosBlob).values({
        cid: cid.toString(),
        mimeType: 'text/plain',
        size: 100,
        tempKey: null,
        width: null,
        height: null,
        createdAt: new Date().toISOString(),
        takedownRef: null,
      })

      const result = await reader.hasBlob(cid)
      expect(result).toBe(true)
    })
  })

  describe('getBlobTakedownStatus', () => {
    it('should return null for non-existent blob', async () => {
      const cid = await createCid('nope')
      const result = await reader.getBlobTakedownStatus(cid)
      expect(result).toBeNull()
    })

    it('should return applied: false for non-takendown blob', async () => {
      const cid = await createCid('normal blob')
      await db.insert(stratosBlob).values({
        cid: cid.toString(),
        mimeType: 'text/plain',
        size: 50,
        tempKey: null,
        width: null,
        height: null,
        createdAt: new Date().toISOString(),
        takedownRef: null,
      })

      const result = await reader.getBlobTakedownStatus(cid)
      expect(result).toEqual({ applied: false })
    })

    it('should return applied: true with ref for takendown blob', async () => {
      const cid = await createCid('bad blob')
      await db.insert(stratosBlob).values({
        cid: cid.toString(),
        mimeType: 'text/plain',
        size: 50,
        tempKey: null,
        width: null,
        height: null,
        createdAt: new Date().toISOString(),
        takedownRef: 'MOD-123',
      })

      const result = await reader.getBlobTakedownStatus(cid)
      expect(result).toEqual({ applied: true, ref: 'MOD-123' })
    })
  })

  describe('getRecordsForBlob', () => {
    it('should return empty array if no records use blob', async () => {
      const cid = await createCid('orphan blob')
      const result = await reader.getRecordsForBlob(cid)
      expect(result).toEqual([])
    })

    it('should return record URIs that use the blob', async () => {
      const cid = await createCid('shared blob')
      const uri1 = 'at://did:plc:abc/app.stratos.feed.post/1'
      const uri2 = 'at://did:plc:abc/app.stratos.feed.post/2'

      await db.insert(stratosRecordBlob).values([
        { blobCid: cid.toString(), recordUri: uri1 },
        { blobCid: cid.toString(), recordUri: uri2 },
      ])

      const result = await reader.getRecordsForBlob(cid)
      expect(result).toHaveLength(2)
      expect(result).toContain(uri1)
      expect(result).toContain(uri2)
    })
  })

  describe('listBlobs', () => {
    it('should list blobs with pagination', async () => {
      const cid1 = await createCid('blob1')
      const cid2 = await createCid('blob2')
      const uri = 'at://did:plc:test/app.stratos.feed.post/1'

      await db.insert(stratosRecord).values({
        uri,
        cid: 'record-cid',
        collection: 'app.stratos.feed.post',
        rkey: '1',
        repoRev: 'rev1',
        indexedAt: new Date().toISOString(),
        takedownRef: null,
      })

      await db.insert(stratosRecordBlob).values([
        { blobCid: cid1.toString(), recordUri: uri },
        { blobCid: cid2.toString(), recordUri: uri },
      ])

      const result = await reader.listBlobs({ limit: 10 })
      expect(result).toHaveLength(2)
    })
  })
})

describe('Blob Transactor', () => {
  let db: StratosDb
  let blobStore: BlobStore
  let transactor: StratosBlobTransactor
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-blob-tx-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.db')

    db = createStratosDb(dbPath)
    await migrateStratosDb(db)
    blobStore = createMockBlobStore()
    transactor = new StratosBlobTransactor(db, blobStore)
  })

  afterEach(async () => {
    await closeStratosDb(db)
    await rm(testDir, { recursive: true, force: true })
  })

  describe('trackBlob', () => {
    it('should track a new blob', async () => {
      const cid = await createCid('new blob')

      await transactor.trackBlob({
        cid,
        mimeType: 'image/jpeg',
        size: 5000,
        width: 800,
        height: 600,
      })

      const result = await transactor.getBlobMetadata(cid)
      expect(result).not.toBeNull()
      expect(result?.mimeType).toBe('image/jpeg')
      expect(result?.size).toBe(5000)
    })

    it('should not fail on duplicate blob', async () => {
      const cid = await createCid('duplicate blob')

      await transactor.trackBlob({
        cid,
        mimeType: 'image/png',
        size: 1000,
      })

      // Track again - should not throw
      await expect(transactor.trackBlob({
        cid,
        mimeType: 'image/png',
        size: 1000,
      })).resolves.not.toThrow()
    })
  })

  describe('associateBlobWithRecord', () => {
    it('should create blob-record association', async () => {
      const cid = await createCid('associated blob')
      const uri = 'at://did:plc:test/app.stratos.feed.post/123'

      await transactor.associateBlobWithRecord(cid, uri)

      const records = await transactor.getRecordsForBlob(cid)
      expect(records).toContain(uri)
    })

    it('should handle duplicate associations gracefully', async () => {
      const cid = await createCid('blob with dupes')
      const uri = 'at://did:plc:test/app.stratos.feed.post/456'

      await transactor.associateBlobWithRecord(cid, uri)
      await expect(
        transactor.associateBlobWithRecord(cid, uri)
      ).resolves.not.toThrow()

      const records = await transactor.getRecordsForBlob(cid)
      expect(records).toHaveLength(1)
    })
  })

  describe('removeRecordBlobAssociations', () => {
    it('should remove all blob associations for a record', async () => {
      const cid1 = await createCid('blob1')
      const cid2 = await createCid('blob2')
      const uri = 'at://did:plc:test/app.stratos.feed.post/789'

      await transactor.associateBlobWithRecord(cid1, uri)
      await transactor.associateBlobWithRecord(cid2, uri)

      let records1 = await transactor.getRecordsForBlob(cid1)
      let records2 = await transactor.getRecordsForBlob(cid2)
      expect(records1).toHaveLength(1)
      expect(records2).toHaveLength(1)

      await transactor.removeRecordBlobAssociations(uri)

      records1 = await transactor.getRecordsForBlob(cid1)
      records2 = await transactor.getRecordsForBlob(cid2)
      expect(records1).toHaveLength(0)
      expect(records2).toHaveLength(0)
    })
  })

  describe('updateBlobTakedown', () => {
    it('should apply takedown to blob', async () => {
      const cid = await createCid('takedown blob')
      await transactor.trackBlob({ cid, mimeType: 'image/png', size: 100 })

      await transactor.updateBlobTakedown(cid, { applied: true, ref: 'TD-001' })

      const status = await transactor.getBlobTakedownStatus(cid)
      expect(status?.applied).toBe(true)
      expect(status?.ref).toBe('TD-001')
    })

    it('should remove takedown from blob', async () => {
      const cid = await createCid('restored blob')
      await db.insert(stratosBlob).values({
        cid: cid.toString(),
        mimeType: 'image/png',
        size: 100,
        tempKey: null,
        width: null,
        height: null,
        createdAt: new Date().toISOString(),
        takedownRef: 'TD-002',
      })

      await transactor.updateBlobTakedown(cid, { applied: false })

      const status = await transactor.getBlobTakedownStatus(cid)
      expect(status?.applied).toBe(false)
    })
  })

  describe('deleteOrphanBlobs', () => {
    it('should delete blobs not associated with any record', async () => {
      const orphanCid = await createCid('orphan')
      const usedCid = await createCid('used')
      const uri = 'at://did:plc:test/app.stratos.feed.post/1'

      // Track both blobs
      await transactor.trackBlob({ cid: orphanCid, mimeType: 'image/png', size: 50 })
      await transactor.trackBlob({ cid: usedCid, mimeType: 'image/png', size: 50 })

      // Only associate one
      await transactor.associateBlobWithRecord(usedCid, uri)

      // Delete orphans
      const deleted = await transactor.deleteOrphanBlobs()

      expect(deleted).toHaveLength(1)
      expect(deleted[0].toString()).toBe(orphanCid.toString())

      // Verify orphan is gone
      const orphanExists = await transactor.hasBlob(orphanCid)
      const usedExists = await transactor.hasBlob(usedCid)
      expect(orphanExists).toBe(false)
      expect(usedExists).toBe(true)
    })

    it('should call blobstore.delete for orphan blobs', async () => {
      const orphanCid = await createCid('orphan to delete')
      await transactor.trackBlob({ cid: orphanCid, mimeType: 'image/png', size: 50 })

      await transactor.deleteOrphanBlobs()

      expect(blobStore.delete).toHaveBeenCalledWith(orphanCid)
    })
  })
})
