import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdir, rm} from 'fs/promises'
import {join} from 'path'
import {tmpdir} from 'os'
import {randomBytes} from 'crypto'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'
import {AtUri} from '@atproto/syntax'

import {BlobStore} from '@northsky/stratos-core'
import {
  createServiceDb,
  migrateServiceDb,
  closeServiceDb,
  ServiceDb,
} from '../src/db/index.js'

import {
  StratosActorStore,
  SqliteEnrollmentStore,
  AppContext,
} from '../src/context.js'
import {
  createRecord,
} from '../src/api/records.js'

// Create a deterministic CID from data
const createCid = async (data: string | Buffer): Promise<CID> => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

// Mock blob store
function createMockBlobStore(): BlobStore {
  const storage = new Map<string, Buffer>()
  const tempStorage = new Map<string, Buffer>()

  return {
    putTemp: vi.fn().mockImplementation(async (bytes: Buffer) => {
      const key = `temp-${randomBytes(8).toString('hex')}`
      if (Buffer.isBuffer(bytes)) {
        tempStorage.set(key, bytes)
      }
      return key
    }),
    makePermanent: vi.fn().mockImplementation(async (key: string, cid: CID) => {
      const bytes = tempStorage.get(key)
      if (bytes) {
        storage.set(cid.toString(), bytes)
        tempStorage.delete(key)
      }
    }),
    putPermanent: vi.fn().mockImplementation(async (cid: CID, bytes: Buffer) => {
      if (Buffer.isBuffer(bytes)) {
        storage.set(cid.toString(), bytes)
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
      return tempStorage.has(key)
    }),
    hasStored: vi.fn().mockImplementation(async (cid: CID) => {
      return storage.has(cid.toString())
    }),
    getBytes: vi.fn().mockImplementation(async (cid: CID) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) {
        throw new Error('Blob not found')
      }
      return bytes
    }),
    getStream: vi.fn().mockImplementation(async (cid: CID) => {
      const bytes = storage.get(cid.toString())
      if (!bytes) {
        throw new Error('Blob not found')
      }

      async function* generate() {
        yield bytes!
      }

      return generate()
    }),
  }
}

// CBOR decoder mock (just JSON for testing)
function cborToRecord(bytes: Buffer): Record<string, unknown> {
  return JSON.parse(bytes.toString('utf8'))
}

// Create minimal app context for testing API functions
interface TestContext {
  actorStore: StratosActorStore
  enrollmentStore: {
    isEnrolled: (did: string) => Promise<boolean>
    enroll: (record: { did: string; enrolledAt: string; pdsEndpoint?: string }) => Promise<void>
  }
  stratosConfig: { allowedDomains: string[]; retentionDays: number }
}

describe('API Records', () => {
  let testDir: string
  let testContext: TestContext
  let testDid: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-api-test-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, {recursive: true})

    testDid = 'did:plc:testuser'

    const actorStore = new StratosActorStore({
      dataDir: join(testDir, 'actors'),
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })

    // Simple in-memory enrollment store for testing
    const enrolledDids = new Set<string>()
    const enrollmentStore = {
      isEnrolled: async (did: string) => enrolledDids.has(did),
      enroll: async (record: { did: string; enrolledAt: string; pdsEndpoint?: string }) => {
        enrolledDids.add(record.did)
      },
    }

    testContext = {
      actorStore,
      enrollmentStore,
      stratosConfig: {
        allowedDomains: ['example.com', 'test.com'],
        retentionDays: 30,
      },
    }
  })

  afterEach(async () => {
    await rm(testDir, {recursive: true, force: true})
  })

  describe('enrollment check', () => {
    it('should reject non-enrolled user', async () => {
      const mockCtx = {
        enrollmentStore: testContext.enrollmentStore,
        actorStore: testContext.actorStore,
      } as unknown as AppContext

      await expect(
        createRecord(
          mockCtx,
          {
            repo: testDid,
            collection: 'app.stratos.feed.post',
            record: {
              text: 'Hello',
              boundary: {values: [{value: 'example.com'}]},
              createdAt: new Date().toISOString(),
            },
          },
          testDid,
        )
      ).rejects.toThrow('not enrolled')
    })

    it('should allow enrolled user', async () => {
      // Enroll the user first
      await testContext.enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.test.com',
      })

      const isEnrolled = await testContext.enrollmentStore.isEnrolled(testDid)
      expect(isEnrolled).toBe(true)
    })
  })

  describe('authorization', () => {
    it('should reject creating record for another user', async () => {
      const mockCtx = {
        enrollmentStore: testContext.enrollmentStore,
        actorStore: testContext.actorStore,
      } as unknown as AppContext

      const otherDid = 'did:plc:otheruser'

      await expect(
        createRecord(
          mockCtx,
          {
            repo: otherDid,
            collection: 'app.stratos.feed.post',
            record: {text: 'test'},
          },
          testDid,
        )
      ).rejects.toThrow('another user')
    })
  })

  describe('collection validation', () => {
    it('should reject non-stratos collections', async () => {
      await testContext.enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
      })

      const mockCtx = {
        enrollmentStore: testContext.enrollmentStore,
        actorStore: testContext.actorStore,
      } as unknown as AppContext

      await expect(
        createRecord(
          mockCtx,
          {
            repo: testDid,
            collection: 'app.bsky.feed.post', // Wrong namespace
            record: {text: 'test'},
          },
          testDid,
        )
      ).rejects.toThrow('app.stratos')
    })
  })
})

describe('SqliteEnrollmentStore', () => {
  let db: ServiceDb
  let store: SqliteEnrollmentStore
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-enrollment-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, {recursive: true})
    const dbPath = join(testDir, 'test.sqlite')

    db = createServiceDb(dbPath)

    // Run migrations to create enrollment table
    await migrateServiceDb(db)

    store = new SqliteEnrollmentStore(db)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(testDir, {recursive: true, force: true})
  })

  describe('isEnrolled', () => {
    it('should return false for non-enrolled DID', async () => {
      const result = await store.isEnrolled('did:plc:notexist')
      expect(result).toBe(false)
    })

    it('should return true for enrolled DID', async () => {
      await store.enroll({
        did: 'did:plc:enrolled',
        enrolledAt: new Date().toISOString(),
      })

      const result = await store.isEnrolled('did:plc:enrolled')
      expect(result).toBe(true)
    })
  })

  describe('enroll', () => {
    it('should enroll a new user', async () => {
      await store.enroll({
        did: 'did:plc:newuser',
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.example.com',
      })

      const result = await store.getEnrollment('did:plc:newuser')
      expect(result).not.toBeNull()
      expect(result?.did).toBe('did:plc:newuser')
      expect(result?.pdsEndpoint).toBe('https://pds.example.com')
    })

    it('should update enrollment on conflict', async () => {
      const did = 'did:plc:updateme'

      await store.enroll({
        did,
        enrolledAt: '2024-01-01T00:00:00Z',
        pdsEndpoint: 'https://old.pds.com',
      })

      await store.enroll({
        did,
        enrolledAt: '2024-06-01T00:00:00Z',
        pdsEndpoint: 'https://new.pds.com',
      })

      const result = await store.getEnrollment(did)
      expect(result?.pdsEndpoint).toBe('https://new.pds.com')
      expect(result?.enrolledAt).toBe('2024-06-01T00:00:00Z')
    })
  })

  describe('unenroll', () => {
    it('should remove enrollment', async () => {
      const did = 'did:plc:leaveme'

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
      })

      expect(await store.isEnrolled(did)).toBe(true)

      await store.unenroll(did)

      expect(await store.isEnrolled(did)).toBe(false)
    })

    it('should not fail on non-existent DID', async () => {
      await expect(store.unenroll('did:plc:notexist')).resolves.not.toThrow()
    })
  })

  describe('getEnrollment', () => {
    it('should return null for non-enrolled DID', async () => {
      const result = await store.getEnrollment('did:plc:nope')
      expect(result).toBeNull()
    })

    it('should return enrollment details', async () => {
      const did = 'did:plc:getme'
      const enrolledAt = new Date().toISOString()

      await store.enroll({
        did,
        enrolledAt,
        pdsEndpoint: 'https://pds.test.com',
      })

      const result = await store.getEnrollment(did)
      expect(result).not.toBeNull()
      expect(result?.did).toBe(did)
      expect(result?.enrolledAt).toBe(enrolledAt)
      expect(result?.pdsEndpoint).toBe('https://pds.test.com')
    })

    it('should return undefined pdsEndpoint when null', async () => {
      const did = 'did:plc:nopds'

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
      })

      const result = await store.getEnrollment(did)
      expect(result?.pdsEndpoint).toBeUndefined()
    })
  })

  describe('boundaries', () => {
    it('should return empty array for user with no boundaries', async () => {
      await store.enroll({
        did: 'did:plc:nobounds',
        enrolledAt: new Date().toISOString(),
      })

      const boundaries = await store.getBoundaries('did:plc:nobounds')
      expect(boundaries).toEqual([])
    })

    it('should store boundaries on enrollment', async () => {
      await store.enroll({
        did: 'did:plc:withbounds',
        enrolledAt: new Date().toISOString(),
        boundaries: ['engineering', 'design'],
      })

      const boundaries = await store.getBoundaries('did:plc:withbounds')
      expect(boundaries).toHaveLength(2)
      expect(boundaries).toContain('engineering')
      expect(boundaries).toContain('design')
    })

    it('should replace boundaries on re-enrollment', async () => {
      const did = 'did:plc:replacebounds'

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        boundaries: ['old'],
      })

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        boundaries: ['new1', 'new2'],
      })

      const boundaries = await store.getBoundaries(did)
      expect(boundaries).toHaveLength(2)
      expect(boundaries).toContain('new1')
      expect(boundaries).toContain('new2')
      expect(boundaries).not.toContain('old')
    })

    it('should delete boundaries on unenroll', async () => {
      const did = 'did:plc:deletebounds'

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        boundaries: ['a', 'b'],
      })

      await store.unenroll(did)

      const boundaries = await store.getBoundaries(did)
      expect(boundaries).toEqual([])
    })

    it('should return empty array for non-enrolled user', async () => {
      const boundaries = await store.getBoundaries('did:plc:nonexistent')
      expect(boundaries).toEqual([])
    })
  })
})

describe('StratosActorStore', () => {
  let actorStore: StratosActorStore
  let testDir: string
  const testDid = 'did:plc:testactor'

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-actor-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, {recursive: true})

    actorStore = new StratosActorStore({
      dataDir: testDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })
  })

  afterEach(async () => {
    await rm(testDir, {recursive: true, force: true})
  })

  describe('exists', () => {
    it('should return false for non-existent actor', async () => {
      const result = await actorStore.exists(testDid)
      expect(result).toBe(false)
    })

    it('should return true after create', async () => {
      await actorStore.create(testDid)

      const result = await actorStore.exists(testDid)
      expect(result).toBe(true)
    })
  })

  describe('create', () => {
    it('should create actor directory and database', async () => {
      await actorStore.create(testDid)

      const exists = await actorStore.exists(testDid)
      expect(exists).toBe(true)
    })
  })

  describe('destroy', () => {
    it('should remove actor directory', async () => {
      await actorStore.create(testDid)
      expect(await actorStore.exists(testDid)).toBe(true)

      await actorStore.destroy(testDid)
      expect(await actorStore.exists(testDid)).toBe(false)
    })

    it('should not fail for non-existent actor', async () => {
      await expect(actorStore.destroy('did:plc:notexist')).resolves.not.toThrow()
    })
  })

  describe('read', () => {
    it('should provide read access to actor store', async () => {
      await actorStore.create(testDid)

      const count = await actorStore.read(testDid, async (store) => {
        return await store.record.recordCount()
      })

      expect(count).toBe(0)
    })
  })

  describe('transact', () => {
    it('should provide write access to actor store', async () => {
      await actorStore.create(testDid)
      const cid = await createCid('test record')

      await actorStore.transact(testDid, async (store) => {
        // Insert a record directly for testing
        const uri = new AtUri('at://did:plc:testactor/app.stratos.feed.post/123')
        await store.record.indexRecord(
          uri,
          cid,
          {text: 'Hello'},
          'create',
          'rev1',
        )
      })

      const count = await actorStore.read(testDid, async (store) => {
        return await store.record.recordCount()
      })

      expect(count).toBe(1)
    })
  })
})
