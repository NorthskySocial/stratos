import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { decode } from '@atcute/cbor'
import {
  computeCid,
  encodeRecord,
  stratosRecordBoundary,
} from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { applyWritesBatch, updateRecord } from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const DOMAIN = 'did:web:nerv.tokyo.jp/engineering'
const COLLECTION = 'zone.stratos.feed.post'
const EXISTING_RKEY = 'unit01'
const NEW_RKEY = 'unit02'
const NOT_ENROLLED_MESSAGE = 'User is not enrolled in this Stratos service'
const SERVICE_WRITE_MESSAGE = 'Service identities cannot create records'

function post(text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: DOMAIN }],
    },
  }
}

describe('Update and batch writes require a writable enrollment', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any
  let getSignFn: ReturnType<typeof vi.fn>
  let emit: ReturnType<typeof vi.fn>

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'

  async function enrollCaller(overrides: {
    active?: boolean
    isService?: boolean
  }) {
    await enrollmentStore.enroll({
      did: testDid,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      boundaries: [DOMAIN],
      signingKeyDid: 'did:key:zDnaeTestKey',
      active: true,
      isService: false,
      custody: 'stratos',
      ...overrides,
    })
  }

  async function snapshotStore() {
    return actorStore.read(testDid, async (store) => {
      const boundaryRows = await (
        store.record as unknown as {
          reader: {
            db: {
              select: () => {
                from: (table: unknown) => Promise<unknown[]>
              }
            }
          }
        }
      ).reader.db
        .select()
        .from(stratosRecordBoundary)
      return {
        records: await store.record.listAll(),
        boundaryRows,
        root: await store.repo.getRootDetailed(),
        events: await store.sequence.getEventsSince(0, 1000),
      }
    })
  }

  function updateOp() {
    return {
      action: 'update' as const,
      collection: COLLECTION,
      rkey: EXISTING_RKEY,
      record: post('Edited by the pilot'),
    }
  }

  function createOp() {
    return {
      action: 'create' as const,
      collection: COLLECTION,
      rkey: NEW_RKEY,
      record: post('Launching Unit-02'),
    }
  }

  function updateCall() {
    return updateRecord(
      ctx,
      {
        repo: testDid,
        collection: COLLECTION,
        rkey: EXISTING_RKEY,
        record: post('Edited by the pilot'),
      },
      testDid,
    )
  }

  const rejectedEnrollments = [
    {
      title: 'a missing enrollment',
      seed: async () => {},
      expected: { error: 'NotEnrolled', message: NOT_ENROLLED_MESSAGE },
    },
    {
      title: 'an inactive enrollment',
      seed: () => enrollCaller({ active: false }),
      expected: { error: 'NotEnrolled', message: NOT_ENROLLED_MESSAGE },
    },
    {
      title: 'a service enrollment',
      seed: () => enrollCaller({ isService: true }),
      expected: {
        error: 'ServiceWriteForbidden',
        message: SERVICE_WRITE_MESSAGE,
      },
    },
  ]

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore() as any,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    getSignFn = vi
      .fn()
      .mockResolvedValue(() => Promise.resolve(new Uint8Array(64)))
    emit = vi.fn()
    ctx = {
      cfg: createTestConfig(dataDir),
      actorStore,
      enrollmentStore,
      serviceDid,
      writeRateLimiter: { assertWriteAllowed: vi.fn() },
      actorSigner: {
        sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
        getSignFn,
        getPublicKey: vi.fn().mockResolvedValue('did:key:zDnaeTestKey'),
        ensureKey: vi.fn().mockResolvedValue(undefined),
      },
      repoWriteLocks: { acquire: vi.fn().mockResolvedValue(() => {}) },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      sequenceEvents: { emit },
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue([DOMAIN]),
      },
    }

    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = post('Original text')
      await store.record.indexRecord(
        `at://${testDid}/${COLLECTION}/${EXISTING_RKEY}`,
        await computeCid(record),
        record,
        'create',
        '3kseedrev0000',
      )
    })
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  describe.each(rejectedEnrollments)('with $title', ({ seed, expected }) => {
    it('rejects an update before signing or any store write', async () => {
      await seed()
      const before = await snapshotStore()

      await expect(updateCall()).rejects.toMatchObject(expected)

      expect(getSignFn).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(await snapshotStore()).toEqual(before)
    })

    it('rejects a batch of only creates before signing or any store write', async () => {
      await seed()
      const before = await snapshotStore()

      await expect(
        applyWritesBatch(ctx, testDid, [createOp()]),
      ).rejects.toMatchObject(expected)

      expect(getSignFn).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(await snapshotStore()).toEqual(before)
    })

    it('rejects a batch holding an update before signing or any store write', async () => {
      await seed()
      const before = await snapshotStore()

      await expect(
        applyWritesBatch(ctx, testDid, [updateOp()]),
      ).rejects.toMatchObject(expected)

      expect(getSignFn).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(await snapshotStore()).toEqual(before)
    })
  })

  describe('with an active, stratos-custody, non-service enrollment', () => {
    beforeEach(async () => {
      await enrollCaller({})
    })

    it('still accepts an update', async () => {
      const before = await snapshotStore()
      const result = await updateCall()

      expect(result.uri).toBe(`at://${testDid}/${COLLECTION}/${EXISTING_RKEY}`)
      expect(getSignFn).toHaveBeenCalledWith(testDid)
      expect(emit).toHaveBeenCalledWith(testDid)
      const after = await snapshotStore()
      expect(after.root).not.toEqual(before.root)
    })

    it('still accepts a batch of creates', async () => {
      const result = await applyWritesBatch(ctx, testDid, [createOp()])

      expect(result.commit.rev).toEqual(expect.any(String))
      expect(emit).toHaveBeenCalledWith(testDid)
      const after = await snapshotStore()
      expect(after.records.map((record) => record.uri)).toContain(
        `at://${testDid}/${COLLECTION}/${NEW_RKEY}`,
      )
    })

    it('still accepts a batch holding an update', async () => {
      const before = await snapshotStore()
      await applyWritesBatch(ctx, testDid, [updateOp()])

      const after = await snapshotStore()
      expect(after.root).not.toEqual(before.root)
    })
  })
})
