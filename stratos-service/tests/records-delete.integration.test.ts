import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { deleteRecord, getRecord } from '../src/api'
import { createMockBlobStore, createTestConfig } from './utils'

describe('Record Delete Handler', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const collection = 'zone.stratos.feed.post'
  const rkey = 'post1'

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
      writeRateLimiter: {
        assertWriteAllowed: vi.fn(),
      },
      getActorSigningKey: vi.fn().mockResolvedValue({
        did: 'did:key:zDnaeTestKey',
        sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
      }),
      repoWriteLocks: {
        acquire: vi.fn().mockResolvedValue(() => {}),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      sequenceEvents: {
        emit: vi.fn(),
      },
      stubQueue: {
        enqueueDelete: vi.fn(),
      },
    }

    // Setup actor and a record
    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = {
        $type: collection,
        text: 'To be deleted',
        createdAt: new Date().toISOString(),
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: 'did:web:nerv.tokyo.jp/engineering' }],
        },
      }
      const cid = await createTestCid(record)
      await store.record.putRecord({
        uri: `at://${testDid}/${collection}/${rkey}`,
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

  it('should successfully delete a record', async () => {
    const result = await deleteRecord(
      ctx,
      {
        repo: testDid,
        collection,
        rkey,
      },
      testDid,
    )

    expect(result.commit).toBeDefined()

    // Verify it's gone from the database
    await expect(
      getRecord(
        ctx,
        {
          repo: testDid,
          collection,
          rkey,
        },
        testDid,
      ),
    ).rejects.toThrow('Record not found')

    // Verify stub was enqueued
    expect(ctx.stubQueue.enqueueDelete).toHaveBeenCalledWith(
      testDid,
      collection,
      rkey,
    )

    // Verify event was emitted
    expect(ctx.sequenceEvents.emit).toHaveBeenCalledWith(testDid)
  })

  it('should throw AuthRequiredError when deleting another users record', async () => {
    await expect(
      deleteRecord(
        ctx,
        {
          repo: testDid,
          collection,
          rkey,
        },
        'did:plc:other',
      ),
    ).rejects.toThrow('Cannot delete record for another user')
  })

  it('should throw InvalidRequestError for non-stratos collection', async () => {
    await expect(
      deleteRecord(
        ctx,
        {
          repo: testDid,
          collection: 'app.bsky.feed.post',
          rkey,
        },
        testDid,
      ),
    ).rejects.toThrow('Only zone.stratos.* collections are supported')
  })

  it('should handle deleting non-existent record gracefully in repo (idempotent-ish)', async () => {
    // deleteRecord currently doesn't check if it exists before trying to delete from repo/db
    // It should just succeed or at least not crash if we try to delete something that doesn't exist
    const result = await deleteRecord(
      ctx,
      {
        repo: testDid,
        collection,
        rkey: 'missing',
      },
      testDid,
    )

    expect(result.commit).toBeDefined()
    expect(ctx.stubQueue.enqueueDelete).toHaveBeenCalledWith(
      testDid,
      collection,
      'missing',
    )
  })
})
