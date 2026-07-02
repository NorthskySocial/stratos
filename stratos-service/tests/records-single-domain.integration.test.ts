/**
 * SWP-03 write-path enforcement: exactly one domain per record.
 *
 * Zero-domain and multi-domain records are rejected on EVERY write entry point
 * (create, update, batch). Delete carries no domain and is unaffected. The
 * single domain's bare name must be a valid skey.
 */
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
import {
  applyWritesBatch,
  assertCallerCanWriteDomains,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

/** Records with 0 or >1 domains must be rejected, whichever validator fires. */
const REJECT_DOMAIN_COUNT = /exactly one domain|must have a boundary/

const DOMAIN_A = 'did:web:nerv.tokyo.jp/engineering'
const DOMAIN_B = 'did:web:nerv.tokyo.jp/design'

describe('Single-domain write enforcement', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:shinji-ikari'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const collection = 'zone.stratos.feed.post'

  function postWithDomains(domains: string[], text = 'hi') {
    return {
      $type: collection,
      text,
      createdAt: new Date().toISOString(),
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: domains.map((value) => ({ value })),
      },
    }
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
      stubQueue: { enqueueWrite: vi.fn(), enqueueDelete: vi.fn() },
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue([DOMAIN_A, DOMAIN_B]),
      },
    }

    await actorStore.create(testDid)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  async function seedRecord(rkey: string) {
    await actorStore.transact(testDid, async (store) => {
      const record = postWithDomains([DOMAIN_A], 'seed')
      const cid = await computeCid(record)
      await store.record.putRecord({
        uri: `at://${testDid}/${collection}/${rkey}`,
        cid,
        value: record,
        content: encodeRecord(record),
      })
    })
  }

  describe('create', () => {
    it('rejects a zero-domain record', async () => {
      await expect(
        createRecord(
          ctx,
          { repo: testDid, collection, record: postWithDomains([]) },
          testDid,
        ),
      ).rejects.toThrow(REJECT_DOMAIN_COUNT)
    })

    it('rejects a two-domain record', async () => {
      await expect(
        createRecord(
          ctx,
          {
            repo: testDid,
            collection,
            record: postWithDomains([DOMAIN_A, DOMAIN_B]),
          },
          testDid,
        ),
      ).rejects.toThrow(REJECT_DOMAIN_COUNT)
    })

    it('accepts a single-domain record', async () => {
      const result = await createRecord(
        ctx,
        {
          repo: testDid,
          collection,
          rkey: 'ok1',
          record: postWithDomains([DOMAIN_A]),
        },
        testDid,
      )
      expect(result.uri).toContain('ok1')
    })
  })

  describe('update', () => {
    it('rejects a zero-domain record', async () => {
      await seedRecord('u0')
      await expect(
        (updateRecord as any)(
          ctx,
          {
            repo: testDid,
            collection,
            rkey: 'u0',
            record: postWithDomains([]),
          },
          testDid,
        ),
      ).rejects.toThrow(REJECT_DOMAIN_COUNT)
    })

    it('rejects a two-domain record', async () => {
      await seedRecord('u2')
      await expect(
        (updateRecord as any)(
          ctx,
          {
            repo: testDid,
            collection,
            rkey: 'u2',
            record: postWithDomains([DOMAIN_A, DOMAIN_B]),
          },
          testDid,
        ),
      ).rejects.toThrow(REJECT_DOMAIN_COUNT)
    })
  })

  describe('batch', () => {
    it('rejects a zero-domain op', async () => {
      await expect(
        applyWritesBatch(ctx, testDid, [
          {
            action: 'create',
            collection,
            rkey: 'b0',
            record: postWithDomains([]),
          },
        ]),
      ).rejects.toThrow(REJECT_DOMAIN_COUNT)
    })

    it('rejects a two-domain op', async () => {
      await expect(
        applyWritesBatch(ctx, testDid, [
          {
            action: 'create',
            collection,
            rkey: 'b2',
            record: postWithDomains([DOMAIN_A, DOMAIN_B]),
          },
        ]),
      ).rejects.toThrow(REJECT_DOMAIN_COUNT)
    })
  })

  // Direct checks of the shared enforcement helper. `validateWritableRecord`
  // runs the record-shape validator (`assertValid`) first, which also rejects
  // zero-boundary and disallowed domains; these assertions pin the distinct
  // exactly-one and skey errors the helper itself raises.
  describe('assertCallerCanWriteDomains (shared helper)', () => {
    it('rejects zero domains with InvalidDomainCount', async () => {
      await expect(
        assertCallerCanWriteDomains(
          ctx,
          testDid,
          collection,
          postWithDomains([]),
        ),
      ).rejects.toThrow(/exactly one domain, received 0/)
    })

    it('rejects two domains with InvalidDomainCount', async () => {
      await expect(
        assertCallerCanWriteDomains(
          ctx,
          testDid,
          collection,
          postWithDomains([DOMAIN_A, DOMAIN_B]),
        ),
      ).rejects.toThrow(/exactly one domain, received 2/)
    })

    it('rejects a domain whose bare name is not a valid skey', async () => {
      // A space in the bare name violates record-key syntax.
      await expect(
        assertCallerCanWriteDomains(
          ctx,
          testDid,
          collection,
          postWithDomains(['did:web:nerv.tokyo.jp/not a skey']),
        ),
      ).rejects.toThrow(/valid domain skey/)
    })

    it('accepts a single valid-skey domain the caller holds', async () => {
      await expect(
        assertCallerCanWriteDomains(
          ctx,
          testDid,
          collection,
          postWithDomains([DOMAIN_A]),
        ),
      ).resolves.toBeUndefined()
    })
  })
})
