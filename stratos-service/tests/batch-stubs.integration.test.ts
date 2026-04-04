import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { CID } from '@atproto/lex-data'
import { AtUri } from '@atproto/syntax'
import { encode as cborEncode } from '@atproto/lex-cbor'
import { sha256 } from 'multiformats/hashes/sha2'
import * as dagCbor from '@ipld/dag-cbor'
import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import { createServiceDb, migrateServiceDb } from '../src/db/index.js'
import { applyWritesBatch } from '../src/api/records/batch.js'
import { type AppContext } from '../src/context-types.js'
import { BackgroundStubQueue } from '../src/features/stub/internal/background-queue.js'
import { Secp256k1Keypair } from '@atproto/crypto'

const DAG_CBOR_CODEC = 0x71

describe('applyWritesBatch PDS Stubs', () => {
  let testDir: string
  let serviceDb: any
  let enrollmentStore: SqliteEnrollmentStore
  let actorStore: StratosActorStore
  let stubQueue: BackgroundStubQueue
  let ctx: Partial<AppContext>
  const testDid = 'did:plc:asuka'
  const serviceDid = 'did:web:stratos.actor'

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `stratos-batch-test-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(testDir, { recursive: true })

    const dbPath = join(testDir, 'service.sqlite')
    serviceDb = createServiceDb(dbPath)
    await migrateServiceDb(serviceDb)

    enrollmentStore = new SqliteEnrollmentStore(serviceDb)
    actorStore = new StratosActorStore({
      dataDir: join(testDir, 'actors'),
      blobstore: () =>
        ({
          put: vi.fn(),
          get: vi.fn(),
          has: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        }) as any,
      cborToRecord: (bytes) => dagCbor.decode(bytes) as any,
    })

    stubQueue = {
      enqueueWrite: vi.fn(),
      enqueueDelete: vi.fn(),
    } as any

    const signingKey = await Secp256k1Keypair.create()

    ctx = {
      serviceDid: 'did:web:stratos.actor',
      cfg: {
        stratos: {
          allowedDomains: ['stratos.actor'],
          boundaries: {
            requireOne: true,
          },
        },
      } as any,
      enrollmentStore,
      actorStore,
      stubQueue,
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue(['stratos.actor']),
      } as any,
      repoWriteLocks: {
        acquire: vi.fn().mockResolvedValue(() => {}),
      } as any,
      writeRateLimiter: {
        assertWriteAllowed: vi.fn(),
      } as any,
      getActorSigningKey: vi.fn().mockResolvedValue(signingKey),
      sequenceEvents: {
        emit: vi.fn(),
      } as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
    }

    await enrollmentStore.enroll({
      did: testDid,
      enrolledAt: new Date().toISOString(),
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zDnaeTestKey123',
      active: true,
      enrollmentRkey: 'enroll1',
      boundaries: ['stratos.actor'],
    })
    await actorStore.create(testDid)
  })

  afterEach(async () => {
    if (serviceDb?._client) {
      serviceDb._client.close()
    }
    await rm(testDir, { recursive: true, force: true })
  })

  it('should enqueue PDS stubs for batch writes', async () => {
    const ops = [
      {
        action: 'create' as const,
        collection: 'zone.stratos.feed.post',
        rkey: 'post1',
        record: {
          text: 'First post',
          createdAt: new Date().toISOString(),
          boundary: {
            values: [{ value: 'did:web:stratos.actor/stratos.actor' }],
          },
        },
      },
      {
        action: 'create' as const,
        collection: 'zone.stratos.feed.post',
        rkey: 'post2',
        record: {
          text: 'Second post',
          createdAt: new Date().toISOString(),
          boundary: {
            values: [{ value: 'did:web:stratos.actor/stratos.actor' }],
          },
        },
      },
    ]

    const result = await applyWritesBatch(ctx as AppContext, testDid, ops)

    expect(result.results).toHaveLength(2)
    expect(stubQueue.enqueueWrite).toHaveBeenCalledTimes(2)
    expect(stubQueue.enqueueWrite).toHaveBeenCalledWith(
      testDid,
      'zone.stratos.feed.post',
      'post1',
      'zone.stratos.feed.post',
      expect.anything(),
      expect.any(String),
    )
    expect(stubQueue.enqueueWrite).toHaveBeenCalledWith(
      testDid,
      'zone.stratos.feed.post',
      'post2',
      'zone.stratos.feed.post',
      expect.anything(),
      expect.any(String),
    )
  })

  it('should enqueue PDS delete stubs for batch deletes', async () => {
    // First create a record to delete via applyWritesBatch to ensure valid repo state
    const createOps = [
      {
        action: 'create' as const,
        collection: 'zone.stratos.feed.post',
        rkey: 'del1',
        record: {
          text: 'To be deleted',
          createdAt: new Date().toISOString(),
          boundary: {
            values: [{ value: 'did:web:stratos.actor/stratos.actor' }],
          },
        },
      },
    ]
    await applyWritesBatch(ctx as AppContext, testDid, createOps)

    const ops = [
      {
        action: 'delete' as const,
        collection: 'zone.stratos.feed.post',
        rkey: 'del1',
      },
    ]

    await applyWritesBatch(ctx as AppContext, testDid, ops)

    expect(stubQueue.enqueueDelete).toHaveBeenCalledTimes(1)
    expect(stubQueue.enqueueDelete).toHaveBeenCalledWith(
      testDid,
      'zone.stratos.feed.post',
      'del1',
    )
  })

  it('should not enqueue stubs if transaction fails', async () => {
    const ops = [
      {
        action: 'create' as const,
        collection: 'zone.stratos.feed.post',
        rkey: 'fail1',
        record: {
          text: 'This should fail',
          createdAt: new Date().toISOString(),
          boundary: {
            values: [{ value: 'did:web:stratos.actor/stratos.actor' }],
          },
        },
      },
    ]

    // Force failure in buildCommitWithRetry or similar by making actorStore throw
    vi.spyOn(actorStore, 'readThenTransact').mockRejectedValue(
      new Error('DB failure'),
    )

    await expect(
      applyWritesBatch(ctx as AppContext, testDid, ops),
    ).rejects.toThrow('DB failure')

    expect(stubQueue.enqueueWrite).not.toHaveBeenCalled()
    expect(stubQueue.enqueueDelete).not.toHaveBeenCalled()
  })
})
