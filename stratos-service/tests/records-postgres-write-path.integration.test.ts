import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'

import {
  applyWritesBatch,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { decodeEvent, type SeqEvent } from '../src/subscription/index.js'
import type { AppContext } from '../src/context.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  startPostgresWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

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
  let harness: WriteHarness
  let ctx: AppContext
  let actorStore: AppContext['actorStore']

  const testDid = 'did:plc:ryoji-kaji'

  async function sequencedOps(action: string): Promise<RawOp[]> {
    const events = await actorStore.read(testDid, async (store: any) => {
      const rows = await store.sequence.getEventsSince(0, 1000)
      return rows.map((row: any): SeqEvent => ({
        seq: row.seq,
        did: row.did,
        time: row.sequencedAt,
        rev: row.rev ?? '',
        event: row.event,
      }))
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
    harness = await startPostgresWriteHarness(await startPostgresContainer())
    ctx = harness.ctx
    actorStore = ctx.actorStore
  }, 120_000)

  afterAll(async () => {
    await harness.close()
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    await harness.enrollMember(testDid, [ENGINEERING, DESIGN])
  })

  afterEach(async () => {
    await ctx.enrollmentStore.unenroll(testDid)
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
