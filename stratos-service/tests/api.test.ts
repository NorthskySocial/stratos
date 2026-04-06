import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { AtUri } from '@atproto/syntax'

import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db'

import {
  AppContext,
  SqliteEnrollmentStore,
  StratosActorStore,
} from '../src/context.js'
import { createRecord } from '../src/api'
import { WriteRateLimiter } from '../src/shared/rate-limiter.js'
import { Did } from '@atproto/api'

import { cborToRecord, createCid, createMockBlobStore } from './utils'

// Create minimal app context for testing API functions
interface TestContext {
  actorStore: StratosActorStore
  enrollmentStore: {
    isEnrolled: (did: string) => Promise<boolean>
    enroll: (record: {
      did: string
      enrolledAt: string
      pdsEndpoint?: string
      signingKeyDid?: string
      active?: boolean
    }) => Promise<void>
  }
  stratosConfig: {
    serviceDid: string
    allowedDomains: string[]
    retentionDays: number
  }
}

describe('API Records', () => {
  let testDir: string
  let testContext: TestContext
  let testDid: Did

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-api-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    testDid = 'did:plc:testuser'

    const actorStore = new StratosActorStore({
      dataDir: join(testDir, 'actors'),
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })

    // Simple in-memory enrollment store for testing
    const enrolledDids = new Set<string>()
    const enrollmentStore = {
      isEnrolled: (did: string) => Promise.resolve(enrolledDids.has(did)),
      enroll: async (record: {
        did: string
        enrolledAt: string
        pdsEndpoint?: string | undefined
        signingKeyDid?: string | undefined
        active?: boolean | undefined
      }) => {
        enrolledDids.add(record.did)
        await Promise.resolve()
      },
    }

    testContext = {
      actorStore,
      enrollmentStore,
      stratosConfig: {
        serviceDid: 'did:web:nerv.tokyo.jp',
        allowedDomains: [
          'did:web:nerv.tokyo.jp/engineering',
          'did:web:nerv.tokyo.jp/design',
        ],
        retentionDays: 30,
      },
    }
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('enrollment check', () => {
    it('should reject non-enrolled user', async () => {
      const mockCtx = {
        enrollmentStore: testContext.enrollmentStore,
        actorStore: testContext.actorStore,
        writeRateLimiter: new WriteRateLimiter(),
      } as unknown as AppContext

      await expect(
        createRecord(
          mockCtx,
          {
            repo: testDid,
            collection: 'zone.stratos.feed.post',
            record: {
              text: 'Hello',
              boundary: {
                values: [{ value: 'did:web:nerv.tokyo.jp/engineering' }],
              },
              createdAt: new Date().toISOString(),
            },
          },
          testDid,
        ),
      ).rejects.toThrow('not enrolled')
    })

    it('should allow enrolled user', async () => {
      // Enroll the user first
      await testContext.enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.test.com',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        writeRateLimiter: new WriteRateLimiter(),
      } as unknown as AppContext

      const otherDid = 'did:plc:otheruser'

      await expect(
        createRecord(
          mockCtx,
          {
            repo: otherDid,
            collection: 'zone.stratos.feed.post',
            record: { text: 'test' },
          },
          testDid,
        ),
      ).rejects.toThrow('another user')
    })
  })

  describe('collection validation', () => {
    it('should reject non-stratos collections', async () => {
      await testContext.enrollmentStore.enroll({
        did: testDid,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      const mockCtx = {
        enrollmentStore: testContext.enrollmentStore,
        actorStore: testContext.actorStore,
        writeRateLimiter: new WriteRateLimiter(),
      } as unknown as AppContext

      await expect(
        createRecord(
          mockCtx,
          {
            repo: testDid,
            collection: 'app.bsky.feed.post', // Wrong namespace
            record: { text: 'test' },
          },
          testDid,
        ),
      ).rejects.toThrow('zone.stratos')
    })
  })
})

describe('SqliteEnrollmentStore', () => {
  let db: ServiceDb
  let store: SqliteEnrollmentStore
  let testDir: string

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-enrollment-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.sqlite')

    db = createServiceDb(dbPath)

    // Run migrations to create enrollment table
    await migrateServiceDb(db)

    store = new SqliteEnrollmentStore(db)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(testDir, { recursive: true, force: true })
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      await store.enroll({
        did,
        enrolledAt: '2024-06-01T00:00:00Z',
        pdsEndpoint: 'https://new.pds.com',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      const boundaries = await store.getBoundaries('did:plc:nobounds')
      expect(boundaries).toEqual([])
    })

    it('should store boundaries on enrollment', async () => {
      await store.enroll({
        did: 'did:plc:withbounds',
        enrolledAt: new Date().toISOString(),
        boundaries: [
          'did:web:nerv.tokyo.jp/engineering',
          'did:web:nerv.tokyo.jp/design',
        ],
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      const boundaries = await store.getBoundaries('did:plc:withbounds')
      expect(boundaries).toHaveLength(2)
      expect(boundaries).toContain('did:web:nerv.tokyo.jp/engineering')
      expect(boundaries).toContain('did:web:nerv.tokyo.jp/design')
    })

    it('should replace boundaries on re-enrollment', async () => {
      const did = 'did:plc:replacebounds'

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        boundaries: ['did:web:nerv.tokyo.jp/old'],
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        boundaries: [
          'did:web:nerv.tokyo.jp/new1',
          'did:web:nerv.tokyo.jp/new2',
        ],
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      const boundaries = await store.getBoundaries(did)
      expect(boundaries).toHaveLength(2)
      expect(boundaries).toContain('did:web:nerv.tokyo.jp/new1')
      expect(boundaries).toContain('did:web:nerv.tokyo.jp/new2')
      expect(boundaries).not.toContain('did:web:nerv.tokyo.jp/old')
    })

    it('should delete boundaries on unenroll', async () => {
      const did = 'did:plc:deletebounds'

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        boundaries: ['did:web:nerv.tokyo.jp/a', 'did:web:nerv.tokyo.jp/b'],
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
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

  describe('enrollmentRkey', () => {
    it('should store and retrieve enrollmentRkey', async () => {
      const did = 'did:plc:reiwithrkey'
      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        pdsEndpoint: 'https://pds.example.com',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const result = await store.getEnrollment(did)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should return undefined enrollmentRkey when not set', async () => {
      const did = 'did:plc:sakuranorkey'
      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      const result = await store.getEnrollment(did)
      expect(result?.enrollmentRkey).toBeUndefined()
    })

    it('should update enrollmentRkey on re-enrollment', async () => {
      const did = 'did:plc:kaorukorkey'
      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: 'did:web:old-stratos.example.com',
      })

      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const result = await store.getEnrollment(did)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })
  })

  describe('updateEnrollment', () => {
    it('should update enrollmentRkey', async () => {
      const did = 'did:plc:fuyukoupdate'
      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      await store.updateEnrollment(did, {
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      const result = await store.getEnrollment(did)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should update pdsEndpoint without affecting other fields', async () => {
      const did = 'did:plc:harukipartial'
      const enrolledAt = '2025-01-01T00:00:00Z'
      await store.enroll({
        did,
        enrolledAt,
        pdsEndpoint: 'https://old.pds.com',
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com',
      })

      await store.updateEnrollment(did, { pdsEndpoint: 'https://new.pds.com' })

      const result = await store.getEnrollment(did)
      expect(result?.pdsEndpoint).toBe('https://new.pds.com')
      expect(result?.enrolledAt).toBe(enrolledAt)
      expect(result?.enrollmentRkey).toBe('did:web:stratos.example.com')
    })

    it('should not fail when no updates provided', async () => {
      const did = 'did:plc:noupdate'
      await store.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        signingKeyDid: 'did:key:zDnaeTestKey123',
        active: true,
      })

      await expect(store.updateEnrollment(did, {})).resolves.not.toThrow()
    })
  })
})

describe('StratosActorStore', () => {
  let actorStore: StratosActorStore
  let testDir: string
  const testDid = 'did:plc:testactor'

  beforeEach(async () => {
    testDir = join(tmpdir(), `stratos-actor-${randomBytes(8).toString('hex')}`)
    await mkdir(testDir, { recursive: true })

    actorStore = new StratosActorStore({
      dataDir: testDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord,
    })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
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
      await expect(
        actorStore.destroy('did:plc:notexist'),
      ).resolves.not.toThrow()
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
        const uri = new AtUri(
          'at://did:plc:testactor/zone.stratos.feed.post/123',
        )
        await store.record.indexRecord(
          uri,
          cid,
          { text: 'Hello' },
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
