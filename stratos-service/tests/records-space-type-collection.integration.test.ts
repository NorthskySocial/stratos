import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'

import { StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { applyWritesBatch } from '../src/api/records/batch.js'
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

describe('Record writes against the hosted space type collections', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let db: ServiceDb
  let ctx: any
  let getEnrollment: ReturnType<typeof vi.fn>
  let getSignFn: ReturnType<typeof vi.fn>

  const testDid = 'did:plc:asuka-langley'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const domain = 'did:web:nerv.tokyo.jp/engineering'
  const unlistedCollection = 'zone.stratos.graph.follow'
  const listedCollection = 'zone.stratos.feed.post'
  const rkey = 'evangelion-unit-02'

  function recordFor(collection: string) {
    return {
      $type: collection,
      subject: 'did:plc:rei-ayanami',
      text: 'Anta baka?',
      createdAt: new Date().toISOString(),
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: domain }],
      },
    }
  }

  async function readRepoRoot() {
    return actorStore.read(testDid, (store) => store.repo.getRoot())
  }

  async function recordExists(collection: string, key: string) {
    return actorStore.read(testDid, (store) =>
      store.record.hasRecord(`at://${testDid}/${collection}/${key}`, null),
    )
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore() as any,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    getEnrollment = vi
      .fn()
      .mockResolvedValue({ active: true, isService: false })
    getSignFn = vi
      .fn()
      .mockResolvedValue(() => Promise.resolve(new Uint8Array(64)))

    ctx = {
      cfg: createTestConfig(dataDir),
      actorStore,
      enrollmentStore: { getEnrollment },
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
      sequenceEvents: { emit: vi.fn() },
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue([domain]),
      },
    }

    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = recordFor(unlistedCollection)
      await store.record.putRecord({
        uri: `at://${testDid}/${unlistedCollection}/${rkey}`,
        cid: await computeCid(record),
        value: record,
        content: encodeRecord(record),
      })
    })
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rejects create, update and delete of an unlisted collection without writing', async () => {
    const rootBefore = await readRepoRoot()

    await expect(
      createRecord(
        ctx,
        {
          repo: testDid,
          collection: unlistedCollection,
          rkey: 'new-follow',
          record: recordFor(unlistedCollection),
        },
        testDid,
      ),
    ).rejects.toMatchObject({ error: 'InvalidCollection' })
    expect(await recordExists(unlistedCollection, 'new-follow')).toBe(false)
    expect(await readRepoRoot()).toEqual(rootBefore)

    await expect(
      (updateRecord as any)(
        ctx,
        {
          repo: testDid,
          collection: unlistedCollection,
          rkey,
          record: recordFor(unlistedCollection),
        },
        testDid,
      ),
    ).rejects.toMatchObject({ error: 'InvalidCollection' })
    expect(await readRepoRoot()).toEqual(rootBefore)

    await expect(
      deleteRecord(
        ctx,
        { repo: testDid, collection: unlistedCollection, rkey },
        testDid,
      ),
    ).rejects.toMatchObject({ error: 'InvalidCollection' })
    expect(await recordExists(unlistedCollection, rkey)).toBe(true)
    expect(await readRepoRoot()).toEqual(rootBefore)

    expect(getEnrollment).not.toHaveBeenCalled()
    expect(getSignFn).not.toHaveBeenCalled()
    expect(ctx.sequenceEvents.emit).not.toHaveBeenCalled()
  })

  it('names the collection and the space type in the rejection', async () => {
    await expect(
      createRecord(
        ctx,
        {
          repo: testDid,
          collection: unlistedCollection,
          record: recordFor(unlistedCollection),
        },
        testDid,
      ),
    ).rejects.toThrow(
      `Collection ${unlistedCollection} is not allowed in space type zone.stratos.space.feed`,
    )
  })

  it('still creates a record in a listed collection', async () => {
    const result = await createRecord(
      ctx,
      {
        repo: testDid,
        collection: listedCollection,
        rkey: 'first-post',
        record: recordFor(listedCollection),
      },
      testDid,
    )

    expect(result.uri).toContain('first-post')
    expect(await recordExists(listedCollection, 'first-post')).toBe(true)
    expect(await readRepoRoot()).not.toBeNull()
  })
  describe('batch writes', () => {
    const batchPostKey = 'batch-post'

    function createOp(collection: string, key: string) {
      return {
        action: 'create' as const,
        collection,
        rkey: key,
        record: recordFor(collection),
      }
    }

    it('rejects a batch creating an unlisted collection', async () => {
      await expect(
        applyWritesBatch(ctx, testDid, [
          createOp(unlistedCollection, 'new-follow'),
        ]),
      ).rejects.toMatchObject({ error: 'InvalidCollection' })
      expect(await recordExists(unlistedCollection, 'new-follow')).toBe(false)
    })

    it('rejects the whole batch when one op is unlisted', async () => {
      const rootBefore = await readRepoRoot()

      await expect(
        applyWritesBatch(ctx, testDid, [
          createOp(listedCollection, batchPostKey),
          createOp(unlistedCollection, 'new-follow'),
        ]),
      ).rejects.toMatchObject({ error: 'InvalidCollection' })

      expect(await recordExists(listedCollection, batchPostKey)).toBe(false)
      expect(await readRepoRoot()).toEqual(rootBefore)
      expect(getEnrollment).not.toHaveBeenCalled()
    })

    it('rejects a batch that only deletes an unlisted collection', async () => {
      const rootBefore = await readRepoRoot()

      await expect(
        applyWritesBatch(ctx, testDid, [
          { action: 'delete', collection: unlistedCollection, rkey },
        ]),
      ).rejects.toMatchObject({ error: 'InvalidCollection' })

      expect(await recordExists(unlistedCollection, rkey)).toBe(true)
      expect(await readRepoRoot()).toEqual(rootBefore)
    })

    it('rejects a batch creating an app.bsky.feed.post', async () => {
      await expect(
        applyWritesBatch(ctx, testDid, [
          createOp('app.bsky.feed.post', 'public-post'),
        ]),
      ).rejects.toMatchObject({ error: 'InvalidCollection' })
    })

    it('still commits a batch of listed collection creates', async () => {
      const result = await applyWritesBatch(ctx, testDid, [
        createOp(listedCollection, 'shinji-post'),
        createOp(listedCollection, 'misato-post'),
      ])

      expect(result.results).toHaveLength(2)
      expect(await recordExists(listedCollection, 'shinji-post')).toBe(true)
      expect(await recordExists(listedCollection, 'misato-post')).toBe(true)
    })
  })
})
