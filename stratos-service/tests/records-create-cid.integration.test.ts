/**
 * A created record must be addressed by the hash of its own content.
 *
 * `computeCid` CBOR-encodes its argument internally, so passing the already
 * encoded `encodeRecord(record)` bytes yields `hash(cbor(cbor(record)))` — a
 * CID that no external verifier re-hashing the stored block can reproduce.
 * These tests pin the create path to the content CID and to the value the
 * update path independently produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import {
  computeCid,
  encodeRecord,
  parseCid,
} from '@northskysocial/stratos-core'
import { decode } from '@atcute/cbor'

import { StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import {
  createRecord,
  getRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const DOMAIN = 'did:web:nerv.tokyo.jp/engineering'

describe('Create record CID derivation', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:asuka-langley'
  const serviceDid = 'did:web:nerv.tokyo.jp'
  const collection = 'zone.stratos.feed.post'

  function post(text: string) {
    return {
      $type: collection,
      text,
      createdAt: '1996-10-04T00:00:00.000Z',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: DOMAIN }],
      },
    }
  }

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-test-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })

    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

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
      boundaryResolver: {
        getBoundaries: vi.fn().mockResolvedValue([DOMAIN]),
      },
    }

    await actorStore.create(testDid)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('returns the CID of the record content, not of its encoded bytes', async () => {
    const record = post('Get in the robot')

    const result = await createRecord(
      ctx,
      { repo: testDid, collection, rkey: 'unit01', record },
      testDid,
    )

    const contentCid = (await computeCid(record)).toString()
    const doubleEncodedCid = (await computeCid(encodeRecord(record))).toString()

    expect(result.cid).toBe(contentCid)
    expect(result.cid).not.toBe(doubleEncodedCid)
  })

  it('agrees with the update path on identical content', async () => {
    const record = post('Anywhere but here')

    const created = await createRecord(
      ctx,
      { repo: testDid, collection, rkey: 'unit02', record },
      testDid,
    )

    const updated = await (updateRecord as any)(
      ctx,
      { repo: testDid, collection, rkey: 'unit02', record },
      testDid,
    )

    expect(updated.cid).toBe(created.cid)
  })

  it('reads back the CID the create response reported', async () => {
    const record = post('The beast that shouted love')

    const created = await createRecord(
      ctx,
      { repo: testDid, collection, rkey: 'unit00', record },
      testDid,
    )

    const read = await getRecord(
      ctx,
      { repo: testDid, collection, rkey: 'unit00' },
      testDid,
    )

    expect(parseCid(read.cid as any).toString()).toBe(created.cid)
  })
})
