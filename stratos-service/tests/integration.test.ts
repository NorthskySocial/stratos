/**
 * Integration tests for Stratos service
 * Tests the complete flow from enrollment to record operations
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID, Cid } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'

import {
  BlobStore,
  BlobStoreCreator,
  ENROLLMENT_MODE,
  StratosValidator,
} from '@northskysocial/stratos-core'

import { IdResolver } from '@atproto/identity'
import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  EnrollmentServiceImpl,
  validateEnrollment,
} from '../src/features/index.js'
import { type StratosServiceConfig } from '../src/index.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'

// Create a deterministic CID from data
const createCid = async (data: string | Uint8Array): Promise<Cid> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

// Mock blob store
function createMockBlobStore(): BlobStore {
  const storage = new Map<string, Uint8Array>()

  return {
    putTemp: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
      const key = `temp-${randomBytes(8).toString('hex')}`
      storage.set(key, bytes)
      return key
    }),
    makePermanent: vi.fn().mockImplementation(async (key: string, cid: Cid) => {
      const bytes = storage.get(key)
      if (bytes) {
        storage.set(cid.toString(), bytes)
        storage.delete(key)
      }
    }),
    putPermanent: vi
      .fn()
      .mockImplementation(
        async (cid: Cid, bytes: Uint8Array | AsyncIterable<Uint8Array>) => {
          if (!(Symbol.asyncIterator in bytes)) {
            storage.set(cid.toString(), bytes)
          } else {
            const chunks: Uint8Array[] = []
            for await (const chunk of bytes) {
              chunks.push(chunk)
            }
            const total = new Uint8Array(
              chunks.reduce((sum, c) => sum + c.length, 0),
            )
            let offset = 0
            for (const chunk of chunks) {
              total.set(chunk, offset)
              offset += chunk.length
            }
            storage.set(cid.toString(), total)
          }
        },
      ),
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
      return storage.has(key)
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
      const bytes = storage.get(key)
      if (!bytes) throw new Error('Blob not found')
      async function* generate() {
        yield bytes!
      }
      return generate()
    }),
  }
}

// Mock blob store creator (factory) for multi-tenant support
function createMockBlobStoreCreator(): BlobStoreCreator {
  // Each DID gets its own blob store instance
  const stores = new Map<string, BlobStore>()
  return (did: string) => {
    if (!stores.has(did)) {
      stores.set(did, createMockBlobStore())
    }
    return stores.get(did)!
  }
}

// CBOR decoder mock
function cborToRecord(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes))
}

// Mock IdResolver
function createMockIdResolver(
  didDoc: { id: string; service?: unknown[] } | null,
) {
  return {
    did: {
      resolve: vi.fn().mockResolvedValue(didDoc),
    },
  } as unknown as IdResolver
}

describe('Integration: Full Stratos Flow', () => {
  let testDir: string
  let actorStore: StratosActorStore
  let enrollmentDb: ServiceDb
  let enrollmentStore: SqliteEnrollmentStore

  const testDid = 'did:plc:integrationtest'
  const testPds = 'https://pds.example.com'

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-integration-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    // Set up the enrollment store
    const enrollmentDbPath = join(testDir, 'enrollment.sqlite')
    enrollmentDb = createServiceDb(enrollmentDbPath)
    await migrateServiceDb(enrollmentDb)

    enrollmentStore = new SqliteEnrollmentStore(enrollmentDb)

    // Set up actor store with a factory pattern
    const blobstore = createMockBlobStoreCreator()
    actorStore = new StratosActorStore({
      dataDir: join(testDir, 'actors'),
      blobstore,
      cborToRecord,
    })
  })

  afterEach(async () => {
    await closeServiceDb(enrollmentDb)
    await rm(testDir, { recursive: true, force: true })
  })

  describe('Enrollment Flow', () => {
    it('should validate enrollment for open mode', async () => {
      const config: StratosServiceConfig['enrollment'] = {
        mode: ENROLLMENT_MODE.OPEN,
        allowedDids: [],
        allowedPdsEndpoints: [],
      }

      const mockResolver = createMockIdResolver(null)
      const result = await validateEnrollment(
        config,
        testDid,
        mockResolver as any,
      )

      expect(result.allowed).toBe(true)
    })

    it('should validate enrollment for allowlist mode with allowed DID', async () => {
      const config: StratosServiceConfig['enrollment'] = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: [testDid],
        allowedPdsEndpoints: [],
      }

      const mockResolver = createMockIdResolver(null)
      const result = await validateEnrollment(
        config,
        testDid,
        mockResolver as any,
      )

      expect(result.allowed).toBe(true)
    })

    it('should validate enrollment for allowlist mode with allowed PDS', async () => {
      const config: StratosServiceConfig['enrollment'] = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: [],
        allowedPdsEndpoints: [testPds],
      }

      const didDoc = {
        id: testDid,
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: testPds,
          },
        ],
      }

      const mockResolver = createMockIdResolver(didDoc)
      const result = await validateEnrollment(
        config,
        testDid,
        mockResolver as any,
      )

      expect(result.allowed).toBe(true)
      expect(result.pdsEndpoint).toBe(testPds)
    })

    it('should reject enrollment when DID cannot be resolved', async () => {
      const config: StratosServiceConfig['enrollment'] = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: [],
        allowedPdsEndpoints: [testPds],
      }

      const mockResolver = createMockIdResolver(null)
      const result = await validateEnrollment(
        config,
        testDid,
        mockResolver as any,
      )

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('DidNotResolved')
    })

    it('should persist enrollment in store', async () => {
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: testPds,
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: 'did:web:stratos.test',
      } as any)

      const isEnrolled = await enrollmentStore.isEnrolled(testDid)
      expect(isEnrolled).toBe(true)

      const enrollment = await enrollmentStore.getEnrollment(testDid)
      expect(enrollment?.pdsEndpoint).toBe(testPds)
      expect(enrollment?.enrollmentRkey).toBe('did:web:stratos.test')
    })
  })

  describe('Record Operations', () => {
    beforeEach(async () => {
      // Enroll user and create actor store
      await enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: testPds,
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: 'did:web:stratos.test',
      })

      await actorStore.create(testDid)
    })

    it('should create and read a stratos record', async () => {
      const uri = `at://${testDid}/zone.stratos.feed.post/123`
      const cid = await createCid('test record content')
      const record = {
        text: 'Hello Stratos!',
        boundary: {
          values: [{ value: 'did:web:nerv.tokyo.jp/evangelion' }],
        },
        createdAt: new Date().toISOString(),
      }

      // Create record
      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(uri, cid, record, 'create', 'rev1')
      })

      // Read record
      const count = await actorStore.read(testDid, async (store) => {
        return await store.record.recordCount()
      })

      expect(count).toBe(1)
    })

    it('should list records by collection', async () => {
      const cid = await createCid('list test')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.feed.post/1`,
          cid,
          { text: 'Post 1' },
          'create',
          'rev1',
        )
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.feed.post/2`,
          cid,
          { text: 'Post 2' },
          'create',
          'rev1',
        )
        await store.record.indexRecord(
          `at://${testDid}/zone.stratos.graph.follow/1`,
          cid,
          { subject: 'did:plc:other' },
          'create',
          'rev1',
        )
      })

      const collections = await actorStore.read(testDid, async (store) => {
        return await store.record.listCollections()
      })

      expect(collections).toHaveLength(2)
      expect(collections).toContain('zone.stratos.feed.post')
      expect(collections).toContain('zone.stratos.graph.follow')
    })

    it('should delete a record', async () => {
      const uri = `at://${testDid}/zone.stratos.feed.post/todelete`
      const cid = await createCid('delete me')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          uri,
          cid,
          { text: 'Delete me' },
          'create',
          'rev1',
        )
      })

      expect(
        await actorStore.read(testDid, (s) => s.record.recordCount()),
      ).toBe(1)

      await actorStore.transact(testDid, async (store) => {
        await store.record.deleteRecord(uri)
      })

      expect(
        await actorStore.read(testDid, (s) => s.record.recordCount()),
      ).toBe(0)
    })

    it('should manage backlinks', async () => {
      const postUri = `at://${testDid}/zone.stratos.feed.post/withbacklinks`
      const cid = await createCid('post with links')

      await actorStore.transact(testDid, async (store) => {
        await store.record.indexRecord(
          postUri,
          cid,
          {
            text: 'Replying to someone',
            reply: {
              parent: {
                uri: 'at://did:plc:other/zone.stratos.feed.post/123',
              },
            },
          },
          'create',
          'rev1',
        )

        await store.record.addBacklinks([
          {
            uri: postUri,
            path: 'reply.parent.uri',
            linkTo: 'at://did:plc:other/zone.stratos.feed.post/123',
          },
        ])
      })

      const backlinks = await actorStore.transact(testDid, async (store) => {
        return await store.record.getRecordBacklinks({
          collection: 'zone.stratos.feed.post',
          path: 'reply.parent.uri',
          linkTo: 'at://did:plc:other/zone.stratos.feed.post/123',
        })
      })

      expect(backlinks).toHaveLength(1)
      expect(backlinks[0].uri).toBe(postUri)
    })
  })

  describe('Validation Integration', () => {
    const stratosConfig = {
      serviceDid: 'did:web:nerv.tokyo.jp',
      allowedDomains: [
        'did:web:nerv.tokyo.jp/evangelion',
        'did:web:nerv.tokyo.jp/magi',
      ],
      retentionDays: 30,
    }

    it('should validate complete stratos post', () => {
      const record = {
        $type: 'zone.stratos.feed.post',
        text: 'This is a valid stratos post',
        boundary: {
          values: [
            { value: 'did:web:nerv.tokyo.jp/evangelion' },
            { value: 'did:web:nerv.tokyo.jp/magi' },
          ],
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        new StratosValidator(stratosConfig).assertValid(
          record,
          'zone.stratos.feed.post',
        )
      }).not.toThrow()
    })

    it('should validate stratos post with stratos reply', () => {
      const record = {
        text: 'Replying to stratos',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/evangelion' }] },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/100',
            cid: 'bafyroot',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        new StratosValidator(stratosConfig).assertValid(
          record,
          'zone.stratos.feed.post',
        )
      }).not.toThrow()
    })

    it('should reject stratos post replying to bsky', () => {
      const record = {
        text: 'Cross-namespace reply',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/evangelion' }] },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/123',
            cid: 'bafyabc',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        new StratosValidator(stratosConfig).assertValid(
          record,
          'zone.stratos.feed.post',
        )
      }).toThrow('cannot reply to a non-stratos record')
    })

    it('should reject stratos post embedding bsky', () => {
      const record = {
        text: 'Quote post',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/evangelion' }] },
        embed: {
          $type: 'app.bsky.embed.record',
          record: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/123',
            cid: 'bafyabc',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        new StratosValidator(stratosConfig).assertValid(
          record,
          'zone.stratos.feed.post',
        )
      }).toThrow('cannot embed bsky content')
    })

    it('should reject bsky post embedding stratos', () => {
      const record = {
        text: 'Quote stratos post',
        embed: {
          record: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
          },
        },
      }

      expect(() => {
        StratosValidator.assertBskyNoCrossNamespaceEmbed(
          record,
          'app.bsky.feed.post',
        )
      }).toThrow('cannot embed stratos content')
    })

    it('should extract boundary domains from record', () => {
      const record = {
        boundary: {
          values: [
            { value: 'did:web:nerv.tokyo.jp/evangelion' },
            { value: 'did:web:nerv.tokyo.jp/magi' },
          ],
        },
      }

      const domains = StratosValidator.extractBoundaryDomains(record)
      expect(domains).toEqual([
        'did:web:nerv.tokyo.jp/evangelion',
        'did:web:nerv.tokyo.jp/magi',
      ])
    })
  })

  describe('URI Classification', () => {
    it('should correctly identify stratos URIs', () => {
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/zone.stratos.feed.post/123',
        ),
      ).toBe(true)
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/zone.stratos.graph.follow/456',
        ),
      ).toBe(true)
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/app.bsky.feed.post/123',
        ),
      ).toBe(false)
    })

    it('should correctly identify bsky URIs', () => {
      expect(
        StratosValidator.isBskyUri('at://did:plc:abc/app.bsky.feed.post/123'),
      ).toBe(true)
      expect(
        StratosValidator.isBskyUri(
          'at://did:plc:abc/app.bsky.actor.profile/self',
        ),
      ).toBe(true)
      expect(
        StratosValidator.isBskyUri(
          'at://did:plc:abc/zone.stratos.feed.post/123',
        ),
      ).toBe(false)
    })

    it('should correctly identify stratos collections', () => {
      expect(
        StratosValidator.isStratosCollection('zone.stratos.feed.post'),
      ).toBe(true)
      expect(
        StratosValidator.isStratosCollection('zone.stratos.graph.follow'),
      ).toBe(true)
      expect(StratosValidator.isStratosCollection('app.bsky.feed.post')).toBe(
        false,
      )
      expect(
        StratosValidator.isStratosCollection('com.atproto.repo.record'),
      ).toBe(false)
    })
  })

  describe('Actor Lifecycle', () => {
    it('should handle complete actor lifecycle (hard delete)', async () => {
      const actorDid = 'did:plc:lifecycle'
      const actorStoreDestroyer = vi.fn().mockImplementation(async (did) => {
        await actorStore.destroy(did)
      })

      const enrollmentService = new EnrollmentServiceImpl(
        enrollmentStore,
        async (did) => {
          await actorStore.create(did)
        },
        actorStoreDestroyer,
      )

      // 1. Enroll
      await enrollmentService.enroll(
        actorDid,
        ['did:web:test.com/domain'],
        'did:key:zDnaeTestKey123' as any,
      )
      expect(await enrollmentStore.isEnrolled(actorDid)).toBe(true)
      expect(await actorStore.exists(actorDid)).toBe(true)

      // 2. Create some records
      const cid = await createCid('lifecycle test')
      await actorStore.transact(actorDid, async (store) => {
        await store.record.indexRecord(
          `at://${actorDid}/zone.stratos.feed.post/1`,
          cid,
          { text: 'Post 1' },
          'create',
          'rev1',
        )
      })

      // 3. Verify records exist
      const count = await actorStore.read(actorDid, (s) =>
        s.record.recordCount(),
      )
      expect(count).toBe(1)

      // 4. Unenroll (Full hard delete)
      await enrollmentService.unenroll(actorDid)

      // 5. Verify hard delete
      expect(await enrollmentStore.isEnrolled(actorDid)).toBe(false)
      const storedEnrollment = await enrollmentStore.getEnrollment(actorDid)
      expect(storedEnrollment).toBeNull()
      expect(await actorStore.exists(actorDid)).toBe(false)
      expect(actorStoreDestroyer).toHaveBeenCalledWith(actorDid)
    })
  })
})
