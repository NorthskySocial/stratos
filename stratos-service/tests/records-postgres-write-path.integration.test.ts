import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { decode } from '@atcute/cbor'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'

import {
  applyWritesBatch,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { decodeEvent, type SeqEvent } from '../src/subscription/index.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const COLLECTION = 'zone.stratos.feed.post'

function boundaryValue(boundary: string) {
  return {
    $type: 'zone.stratos.boundary.defs#Domains',
    values: [{ value: boundary }],
  }
}

function post(boundary: string, text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
    boundary: boundaryValue(boundary),
  }
}

interface RawOp {
  action: string
  path: string
  boundary?: { values: Array<{ value: string }> }
  excludeBoundary?: { values: Array<{ value: string }> }
}

describe('Sequenced write ops carry their boundary on the runtime Postgres store', () => {
  let actorStore: ActorStore
  let ctx: any

  const testDid = 'did:plc:ryoji-kaji'

  async function sequencedOps(action: string): Promise<RawOp[]> {
    const events = await actorStore.read(testDid, async (store: any) => {
      const rows = await store.sequence.getEventsSince(0, 1000)
      return rows.map(
        (row: any): SeqEvent => ({
          seq: row.seq,
          did: row.did,
          time: row.sequencedAt,
          rev: row.rev ?? '',
          event: row.event,
        }),
      )
    })
    return events
      .flatMap(
        (event: SeqEvent) => decodeEvent(event).ops as unknown as RawOp[],
      )
      .filter((op: RawOp) => op.action === action)
  }

  async function seedRecord(rkey: string, boundary: string) {
    await actorStore.transact(testDid, async (store) => {
      const record = post(boundary, 'Original text')
      await store.record.putRecord({
        uri: `at://${testDid}/${COLLECTION}/${rkey}`,
        cid: await computeCid(record),
        value: record,
        content: encodeRecord(record),
      })
    })
  }

  beforeAll(async () => {
    const connectionString = await startPostgresContainer()
    actorStore = new PostgresActorStore({
      connectionString,
      blobstore: createMockBlobStoreCreator(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })
  }, 120_000)

  afterAll(async () => {
    await actorStore.destroy(testDid).catch(() => undefined)
    await stopPostgresContainer()
  })

  beforeEach(async () => {
    ctx = {
      cfg: createTestConfig('/unused-by-postgres'),
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
  })

  afterEach(async () => {
    await actorStore.destroy(testDid)
  })

  it('create sequences an op whose op-level boundary is the authorized boundary', async () => {
    await createRecord(
      ctx,
      {
        repo: testDid,
        collection: COLLECTION,
        rkey: 'shinji',
        record: post(ENGINEERING, 'Get in the robot'),
      },
      testDid,
    )

    const ops = await sequencedOps('create')
    expect(ops).toHaveLength(1)
    expect(ops[0].boundary).toEqual({ values: [{ value: ENGINEERING }] })
  })

  it('move sequences the update under the new boundary, the removal under the old one and excludes the new one', async () => {
    await seedRecord('asuka', ENGINEERING)

    await updateRecord(
      ctx,
      {
        repo: testDid,
        collection: COLLECTION,
        rkey: 'asuka',
        record: post(DESIGN, 'Moved text'),
      },
      testDid,
    )

    const updates = await sequencedOps('update')
    expect(updates).toHaveLength(1)
    expect(updates[0].boundary).toEqual({ values: [{ value: DESIGN }] })

    const removals = await sequencedOps('delete')
    expect(removals).toHaveLength(1)
    expect(removals[0].boundary).toEqual({ values: [{ value: ENGINEERING }] })
    expect(removals[0].excludeBoundary).toEqual({
      values: [{ value: DESIGN }],
    })
  })

  it('batch create sequences an op whose op-level boundary is the authorized boundary', async () => {
    await applyWritesBatch(ctx, testDid, [
      {
        action: 'create',
        collection: COLLECTION,
        rkey: 'ritsuko',
        record: post(DESIGN, 'Magi online'),
      },
    ] as any)

    const ops = await sequencedOps('create')
    expect(ops).toHaveLength(1)
    expect(ops[0].path).toBe(`${COLLECTION}/ritsuko`)
    expect(ops[0].boundary).toEqual({ values: [{ value: DESIGN }] })
  })
})
