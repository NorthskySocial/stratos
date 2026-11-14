import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { decode } from '@atcute/cbor'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'

import { StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { applyWritesBatch } from '../src/api/records/index.js'
import { decodeEvent, type SeqEvent } from '../src/subscription/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const COLLECTION = 'zone.stratos.feed.post'
const RKEY = 'unit03'

function post(boundary: string, text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

describe('Batch update that keeps the boundary', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let db: ServiceDb
  let ctx: any

  const testDid = 'did:plc:ikari-gendo'

  async function sequencedOpActions(): Promise<string[]> {
    const events = await actorStore.read(testDid, async (store: any) => {
      const rows = await store.sequence.getEventsSince(0, 1000)
      return rows.map(
        (row: any): SeqEvent => ({
          seq: row.seq,
          did: row.did,
          time: row.sequencedAt,
          rev: '',
          event: row.event,
        }),
      )
    })
    return events.flatMap((event: SeqEvent) =>
      decodeEvent(event).ops.map((op) => op.action),
    )
  }

  function updateIn(boundary: string) {
    return applyWritesBatch(ctx, testDid, [
      {
        action: 'update',
        collection: COLLECTION,
        rkey: RKEY,
        record: post(boundary, 'Updated text'),
      },
    ] as any)
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

    ctx = {
      cfg: createTestConfig(dataDir),
      actorStore,
      enrollmentStore: {
        getEnrollment: vi
          .fn()
          .mockResolvedValue({ active: true, isService: false }),
      },
      serviceDid: SERVICE_DID,
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
        getBoundaries: vi.fn().mockResolvedValue([ENGINEERING, DESIGN]),
      },
    }

    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = post(ENGINEERING, 'Original text')
      await store.record.putRecord({
        uri: `at://${testDid}/${COLLECTION}/${RKEY}`,
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

  it('sequences exactly one update op and no removal op', async () => {
    await updateIn(ENGINEERING)

    expect(await sequencedOpActions()).toEqual(['update'])
  })

  it('sequences a removal op next to the update when the boundary changes', async () => {
    await updateIn(DESIGN)

    expect((await sequencedOpActions()).sort()).toEqual(['delete', 'update'])
  })
})
