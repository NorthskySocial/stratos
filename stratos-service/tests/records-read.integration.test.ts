import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { CID } from '@atproto/lex-data'
import { sha256 } from 'multiformats/hashes/sha2'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db'
import { getRecord, listRecords } from '../src/api'
import { createMockBlobStore, createTestConfig } from './utils'

describe('Record Read Handlers', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:shinji-ikari'
  const otherDid = 'did:plc:rei-ayanami'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const boundary = 'did:web:nerv.tokyo.jp/engineering'

  async function createTestCid(data: any) {
    const bytes = new TextEncoder().encode(JSON.stringify(data))
    const hash = await sha256.digest(bytes)
    return CID.createV1(0x55, hash)
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => JSON.parse(new TextDecoder().decode(content)),
    })

    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      serviceDid,
    }

    // Setup actor and a record
    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = {
        $type: 'app.bsky.feed.post',
        text: 'Hello Neo Tokyo',
        createdAt: new Date().toISOString(),
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: boundary }],
        },
      }
      const cid = await createTestCid(record)
      await store.record.putRecord({
        uri: `at://${testDid}/app.bsky.feed.post/post1`,
        cid,
        value: record,
        content: new TextEncoder().encode(JSON.stringify(record)),
      })
    })
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('getRecord', () => {
    it('should successfully retrieve a record', async () => {
      const result = await getRecord(
        ctx,
        {
          repo: testDid,
          collection: 'app.bsky.feed.post',
          rkey: 'post1',
        },
        testDid,
      )

      expect(result.uri).toBe(`at://${testDid}/app.bsky.feed.post/post1`)
      expect(result.value).toMatchObject({
        text: 'Hello Neo Tokyo',
      })
    })

    it('should throw 404 for non-existent actor', async () => {
      await expect(
        getRecord(ctx, {
          repo: 'did:plc:missing',
          collection: 'app.bsky.feed.post',
          rkey: 'post1',
        }),
      ).rejects.toThrow('Record not found')
    })

    it('should throw 404 for non-existent record', async () => {
      await expect(
        getRecord(ctx, {
          repo: testDid,
          collection: 'app.bsky.feed.post',
          rkey: 'missing',
        }),
      ).rejects.toThrow('Record not found')
    })

    it('should enforce boundary for non-owner', async () => {
      // Caller has no domains
      await expect(
        getRecord(
          ctx,
          {
            repo: testDid,
            collection: 'app.bsky.feed.post',
            rkey: 'post1',
          },
          otherDid,
          [],
        ),
      ).rejects.toThrow('Record not found')

      // Caller has wrong domains
      await expect(
        getRecord(
          ctx,
          {
            repo: testDid,
            collection: 'app.bsky.feed.post',
            rkey: 'post1',
          },
          otherDid,
          ['did:web:nerv.tokyo.jp/design'],
        ),
      ).rejects.toThrow('Record not found')

      // Caller has correct domain
      const result = await getRecord(
        ctx,
        {
          repo: testDid,
          collection: 'app.bsky.feed.post',
          rkey: 'post1',
        },
        otherDid,
        [boundary],
      )
      expect(result.value).toBeDefined()
    })
  })

  describe('listRecords', () => {
    it('should list records for a collection', async () => {
      const result = await listRecords(
        ctx,
        {
          repo: testDid,
          collection: 'app.bsky.feed.post',
        },
        testDid,
      )

      expect(result.records).toHaveLength(1)
      expect(result.records[0].uri).toContain('post1')
    })

    it('should return empty list for non-existent actor', async () => {
      const result = await listRecords(ctx, {
        repo: 'did:plc:missing',
        collection: 'app.bsky.feed.post',
      })
      expect(result.records).toEqual([])
    })

    it('should filter records by boundary for non-owner', async () => {
      // Add another record without boundary (if possible, though validator might require it)
      // Actually let's add one with a different boundary
      await actorStore.transact(testDid, async (store) => {
        const record = {
          $type: 'app.bsky.feed.post',
          text: 'Confidential',
          createdAt: new Date().toISOString(),
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: 'did:web:nerv.tokyo.jp/design' }],
          },
        }
        const cid = await createTestCid(record)
        await store.record.putRecord({
          uri: `at://${testDid}/app.bsky.feed.post/post2`,
          cid,
          value: record,
          content: new TextEncoder().encode(JSON.stringify(record)),
        })
      })

      // Caller with 'engineering' boundary
      const result = await listRecords(
        ctx,
        {
          repo: testDid,
          collection: 'app.bsky.feed.post',
        },
        otherDid,
        [boundary],
      )

      expect(result.records).toHaveLength(1)
      expect(result.records[0].uri).toContain('post1')
      expect(result.records[0].uri).not.toContain('post2')
    })
  })
})
