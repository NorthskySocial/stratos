import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import type { BlobContentStore } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { getRecord, updateRecord } from '../src/api/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

describe('Record Update Handler', () => {
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
      blobstore: () => createMockBlobStore() as any,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
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
        enqueueWrite: vi.fn(),
      },
      boundaryResolver: {
        getBoundaries: vi
          .fn()
          .mockResolvedValue([
            'did:web:nerv.tokyo.jp/engineering',
            'did:web:nerv.tokyo.jp/design',
          ]),
      },
    }

    // Setup actor and a record
    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = {
        $type: collection,
        text: 'Original text',
        createdAt: new Date().toISOString(),
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: 'did:web:nerv.tokyo.jp/engineering' }],
        },
      }
      const cid = await computeCid(record)
      await store.record.putRecord({
        uri: `at://${testDid}/${collection}/${rkey}`,
        cid,
        value: record,
        content: encodeRecord(record),
      })
    })
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('should successfully update a record', async () => {
    const updatedRecord = {
      $type: collection,
      text: 'Updated text',
      createdAt: new Date().toISOString(),
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: 'did:web:nerv.tokyo.jp/engineering' }],
      },
    }

    const result = await (updateRecord as any)(
      ctx,
      {
        repo: testDid,
        collection,
        rkey,
        record: updatedRecord,
      },
      testDid,
    )

    expect(result.uri).toContain(rkey)
    expect(result.cid).toBeDefined()

    // Verify it's updated in the database
    const readResult = await (getRecord as any)(
      ctx,
      {
        repo: testDid,
        collection,
        rkey,
      },
      testDid,
    )
    expect(readResult.value).toMatchObject({ text: 'Updated text' })

    // Verify stub was enqueued
    expect(ctx.stubQueue.enqueueWrite).toHaveBeenCalled()
  })

  it('should throw AuthRequiredError when updating another users record', async () => {
    await expect(
      (updateRecord as any)(
        ctx,
        {
          repo: testDid,
          collection,
          rkey,
          record: {},
        },
        'did:plc:other',
      ),
    ).rejects.toThrow('Cannot update record for another user')
  })

  it('should throw InvalidRequestError for non-stratos collection', async () => {
    await expect(
      (updateRecord as any)(
        ctx,
        {
          repo: testDid,
          collection: 'app.bsky.feed.post',
          rkey,
          record: {},
        },
        testDid,
      ),
    ).rejects.toThrow('Only zone.stratos.* collections are supported')
  })

  it('should validate boundary changes during update', async () => {
    const updatedRecord = {
      $type: collection,
      text: 'New boundary',
      createdAt: new Date().toISOString(),
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: 'did:web:nerv.tokyo.jp/design' }],
      },
    }

    const result = await (updateRecord as any)(
      ctx,
      {
        repo: testDid,
        collection,
        rkey,
        record: updatedRecord,
      },
      testDid,
    )

    expect(result.uri).toContain(rkey)

    const readResult = await (getRecord as any)(
      ctx,
      {
        repo: testDid,
        collection,
        rkey,
      },
      testDid,
    )

    // Boundary extraction from record.value
    const domains = (readResult.value as any).boundary.values.map(
      (v: any) => v.value,
    )
    expect(domains).toContain('did:web:nerv.tokyo.jp/design')
  })
})
