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
import {
  authorizeRecordBoundary,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

describe('Legacy writes with validate: false still apply the Stratos rules', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const heldDomain = 'did:web:nerv.tokyo.jp/engineering'
  const leadershipDomain = 'did:web:nerv.tokyo.jp/leadership'
  const unlistedDomain = 'did:web:nerv.tokyo.jp/instrumentality'
  const foreignDomain = 'did:web:seele.example/instrumentality'
  const collection = 'zone.stratos.feed.post'
  const ownedRkey = 'unit-01-sortie'
  const ownedPostUri = `at://${testDid}/${collection}/${ownedRkey}`
  const publicPostUri =
    'at://did:plc:misato-katsuragi/app.bsky.feed.post/cross-namespace'
  // A parent in an existing repo, so parent resolution succeeds and the
  // namespace rule is the one that rejects.
  const publicPostInOwnRepoUri = `at://${testDid}/app.bsky.feed.post/cross-namespace`

  function postWith(values: string[] | undefined, extra = {}) {
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
      ...extra,
    }
  }

  function replyTo(parentUri: string) {
    return {
      reply: {
        parent: { uri: parentUri, cid: 'bafyparent' },
        root: { uri: parentUri, cid: 'bafyparent' },
      },
    }
  }

  const publicEmbed = {
    embed: {
      $type: 'app.bsky.embed.record',
      record: { uri: publicPostUri, cid: 'bafyembedded' },
    },
  }

  const writePaths = {
    create: (record: unknown, validate: boolean) =>
      createRecord(
        ctx,
        { repo: testDid, collection, rkey: 'new-post', record, validate },
        testDid,
      ),
    update: (record: unknown, validate: boolean) =>
      updateRecord(
        ctx,
        { repo: testDid, collection, rkey: ownedRkey, record, validate },
        testDid,
      ),
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

    const baseConfig = createTestConfig(dataDir)
    ctx = {
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
      boundaryResolver: {
        getBoundaries: vi
          .fn()
          .mockResolvedValue([heldDomain, leadershipDomain]),
      },
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
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  describe.each(Object.entries(writePaths))('%s', (_path, write) => {
    it('rejects a domain outside allowedDomains', async () => {
      await expect(
        write(postWith([unlistedDomain]), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects a reply whose boundary is not a subset of its parent boundary', async () => {
      await expect(
        write(postWith([leadershipDomain], replyTo(ownedPostUri)), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects a reply that crosses namespaces', async () => {
      await expect(
        write(postWith([heldDomain], replyTo(publicPostInOwnRepoUri)), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects an embed that crosses namespaces', async () => {
      await expect(
        write(postWith([heldDomain], publicEmbed), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects the same records with the same code when validate is true', async () => {
      await expect(
        write(postWith([unlistedDomain]), true),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it.each([true, false])(
      'accepts a record that fails only lexicon validation (validate: %s)',
      async (validate) => {
        const lexiconInvalid = postWith([heldDomain], {
          createdAt: 'not-a-datetime',
        })

        await expect(write(lexiconInvalid, validate)).resolves.toMatchObject({
          uri: expect.stringContaining(collection),
        })
      },
    )

    it('accepts a valid record with validate: false', async () => {
      await expect(write(postWith([heldDomain]), false)).resolves.toMatchObject(
        { uri: expect.stringContaining(collection) },
      )
    })
  })

  describe('authorizeRecordBoundary error codes', () => {
    it('rejects a boundary of another service with ServiceMismatch', async () => {
      await expect(
        authorizeRecordBoundary(
          ctx,
          testDid,
          collection,
          postWith([foreignDomain]),
        ),
      ).rejects.toMatchObject({ error: 'ServiceMismatch' })
    })
  })
})
