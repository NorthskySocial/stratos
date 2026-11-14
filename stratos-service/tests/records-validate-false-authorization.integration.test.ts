import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { decode } from '@atcute/cbor'

import { StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { applyWritesBatch } from '../src/api/records/batch.js'
import { createRecord, updateRecord } from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

describe('Legacy writes with validate: false still authorize the boundary', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let db: ServiceDb
  let ctx: any
  let getBoundaries: ReturnType<typeof vi.fn>

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const heldDomain = 'did:web:nerv.tokyo.jp/engineering'
  const leadershipDomain = 'did:web:nerv.tokyo.jp/leadership'
  const foreignDomain = 'did:web:seele.example/instrumentality'
  const collection = 'zone.stratos.feed.post'
  const ownedRkey = 'unit-01-sortie'
  const publicPostUri =
    'at://did:plc:misato-katsuragi/app.bsky.feed.post/cross-namespace'

  function embeddingPublicPost(values: string[]) {
    return {
      ...postWith(values),
      embed: {
        $type: 'app.bsky.embed.record',
        record: { uri: publicPostUri, cid: 'bafyembedded' },
      },
    }
  }

  function postWith(values: string[] | undefined) {
    return {
      $type: collection,
      text: 'Get in the robot.',
      createdAt: new Date().toISOString(),
      ...(values && {
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: values.map((value) => ({ value })),
        },
      }),
    }
  }

  function createWithoutValidation(
    record: unknown,
    rkey = 'new-post',
  ): Promise<unknown> {
    return createRecord(
      ctx,
      { repo: testDid, collection, rkey, record, validate: false },
      testDid,
    )
  }

  async function snapshotStore() {
    return actorStore.read(testDid, async (store) => ({
      root: await store.repo.getRoot(),
      records: await store.record.listAll(),
      latestSeq: await store.sequence.getLatestSeq(),
    }))
  }

  async function expectNothingWritten(attempt: Promise<unknown>, code: string) {
    const before = await snapshotStore()
    ctx.sequenceEvents.emit.mockClear()
    await expect(attempt).rejects.toMatchObject({ error: code })
    expect(await snapshotStore()).toEqual(before)
    expect(ctx.sequenceEvents.emit).not.toHaveBeenCalled()
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

    getBoundaries = vi.fn().mockResolvedValue([heldDomain])

    const baseConfig = createTestConfig(dataDir)
    ctx = {
      // leadership is a configured domain the caller does not hold, so only
      // the authorization check can reject a write into it
      cfg: {
        ...baseConfig,
        stratos: {
          ...baseConfig.stratos,
          allowedDomains: [heldDomain, leadershipDomain],
        },
      },
      actorStore,
      enrollmentStore: {
        getEnrollment: vi
          .fn()
          .mockResolvedValue({ active: true, isService: false }),
      },
      serviceDid,
      writeRateLimiter: { assertWriteAllowed: vi.fn() },
      actorSigner: {
        sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
        getSignFn: vi
          .fn()
          .mockResolvedValue(() => Promise.resolve(new Uint8Array(64))),
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
      boundaryResolver: { getBoundaries },
    }

    await actorStore.create(testDid)
    await createRecord(
      ctx,
      {
        repo: testDid,
        collection,
        rkey: ownedRkey,
        record: postWith([heldDomain]),
      },
      testDid,
    )
    getBoundaries.mockClear()
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rejects a create into a boundary the caller does not hold', async () => {
    await expectNothingWritten(
      createWithoutValidation(postWith([leadershipDomain])),
      'ForbiddenBoundary',
    )
    expect(getBoundaries).toHaveBeenCalledTimes(1)
    expect(getBoundaries).toHaveBeenCalledWith(testDid)
  })

  it('rejects a create into another service boundary with InvalidRecord', async () => {
    await expectNothingWritten(
      createWithoutValidation(postWith([foreignDomain])),
      'InvalidRecord',
    )
  })

  it('rejects a create with no boundary with InvalidRecord', async () => {
    await expectNothingWritten(
      createWithoutValidation(postWith(undefined)),
      'InvalidRecord',
    )
  })

  it('rejects a create with two boundaries', async () => {
    await expectNothingWritten(
      createWithoutValidation(postWith([heldDomain, leadershipDomain])),
      'InvalidDomainCount',
    )
  })

  it('rejects an update that moves a post into a boundary the caller does not hold', async () => {
    await expectNothingWritten(
      updateRecord(
        ctx,
        {
          repo: testDid,
          collection,
          rkey: ownedRkey,
          record: postWith([leadershipDomain]),
          validate: false,
        },
        testDid,
      ),
      'ForbiddenBoundary',
    )
    expect(getBoundaries).toHaveBeenCalledTimes(1)
  })

  it('rejects a batch create into a boundary the caller does not hold', async () => {
    await expectNothingWritten(
      applyWritesBatch(ctx, testDid, [
        {
          action: 'create',
          collection,
          rkey: 'batch-post',
          record: postWith([leadershipDomain]),
        },
      ]),
      'ForbiddenBoundary',
    )
  })

  it('rejects an embed that crosses namespaces even with validate: false', async () => {
    await expectNothingWritten(
      createWithoutValidation(embeddingPublicPost([heldDomain])),
      'InvalidRecord',
    )
  })

  it('accepts a record that fails only lexicon validation and carries the caller own boundary', async () => {
    const lexiconInvalidPost = {
      ...postWith([heldDomain]),
      createdAt: 'not-a-datetime',
    }

    const result = (await createWithoutValidation(
      lexiconInvalidPost,
      'lenient-post',
    )) as { uri: string }

    expect(result.uri).toContain('lenient-post')
    expect(getBoundaries).toHaveBeenCalledTimes(1)
  })

  it('still runs record validation when validate is true', async () => {
    await expect(
      createRecord(
        ctx,
        {
          repo: testDid,
          collection,
          rkey: 'strict-post',
          record: embeddingPublicPost([heldDomain]),
        },
        testDid,
      ),
    ).rejects.toMatchObject({ error: 'InvalidRecord' })
  })
})
