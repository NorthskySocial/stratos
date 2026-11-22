import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decode, encode } from '@atcute/cbor'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context.js'
import {
  applyWritesBatch,
  createRecord,
  sequenceChange,
  updateRecord,
} from '../src/api/records/index.js'
import {
  decodeEvent,
  eventInScope,
  type SeqEvent,
} from '../src/subscription/index.js'
import { listRepoOps } from '../src/features/pull-sync/index.js'
import {
  startSqliteWriteHarness,
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
  record?: Record<string, unknown>
}

describe('Newly sequenced create and update ops carry the op-level boundary', () => {
  let harness: WriteHarness
  let ctx: AppContext
  let actorStore: AppContext['actorStore']

  const testDid = 'did:plc:misato-katsuragi'

  async function readSeqEvents(): Promise<SeqEvent[]> {
    return actorStore.read(testDid, async (store: any) => {
      const rows = await store.sequence.getEventsSince(0, 1000)
      return rows.map((row: any): SeqEvent => ({
        seq: row.seq,
        did: row.did,
        time: row.sequencedAt,
        rev: row.rev ?? '',
        event: row.event,
      }))
    })
  }

  async function sequencedOps(action: string): Promise<RawOp[]> {
    const events = await readSeqEvents()
    return events
      .flatMap((event) => decodeEvent(event).ops as unknown as RawOp[])
      .filter((op) => op.action === action)
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

  function create(rkey: string, record: Record<string, unknown>) {
    return createRecord(
      ctx,
      { repo: testDid, collection: COLLECTION, rkey, record },
      testDid,
    )
  }

  function update(rkey: string, record: Record<string, unknown>) {
    return updateRecord(
      ctx,
      { repo: testDid, collection: COLLECTION, rkey, record },
      testDid,
    )
  }

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    ctx = harness.ctx
    actorStore = ctx.actorStore
    await harness.enrollMember(testDid, [ENGINEERING, DESIGN])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await harness.close()
  })

  it('create sequences an op whose op-level boundary is the authorized boundary', async () => {
    await create('shinji', post(ENGINEERING, 'Get in the robot'))

    const ops = await sequencedOps('create')
    expect(ops).toHaveLength(1)
    expect(ops[0].boundary).toEqual({ values: [{ value: ENGINEERING }] })
  })

  it('update sequences an op carrying the new boundary', async () => {
    await seedRecord('rei', ENGINEERING)

    await update('rei', post(ENGINEERING, 'Updated text'))

    const ops = await sequencedOps('update')
    expect(ops).toHaveLength(1)
    expect(ops[0].boundary).toEqual({ values: [{ value: ENGINEERING }] })
  })

  it('move sequences the update under the new boundary and the removal under the old one', async () => {
    await seedRecord('asuka', ENGINEERING)

    await update('asuka', post(DESIGN, 'Moved text'))

    const updates = await sequencedOps('update')
    expect(updates).toHaveLength(1)
    expect(updates[0].boundary).toEqual({ values: [{ value: DESIGN }] })

    const removals = await sequencedOps('delete')
    expect(removals).toHaveLength(1)
    expect(removals[0].boundary).toEqual({ values: [{ value: ENGINEERING }] })
  })

  it('batch sequences each create and update op under its own boundary', async () => {
    await seedRecord('kaworu', ENGINEERING)

    await applyWritesBatch(ctx, testDid, [
      {
        action: 'create',
        collection: COLLECTION,
        rkey: 'ritsuko',
        record: post(ENGINEERING, 'Magi online'),
      },
      {
        action: 'create',
        collection: COLLECTION,
        rkey: 'maya',
        record: post(DESIGN, 'Sync ratio rising'),
      },
      {
        action: 'update',
        collection: COLLECTION,
        rkey: 'kaworu',
        record: post(DESIGN, 'Moved by batch'),
      },
    ] as any)

    const opBoundaryByRkey = new Map<string, string[]>()
    for (const op of [
      ...(await sequencedOps('create')),
      ...(await sequencedOps('update')),
    ]) {
      opBoundaryByRkey.set(
        op.path.split('/')[1],
        op.boundary?.values.map((entry) => entry.value) ?? [],
      )
    }
    expect(Object.fromEntries(opBoundaryByRkey)).toEqual({
      ritsuko: [ENGINEERING],
      maya: [DESIGN],
      kaworu: [DESIGN],
    })
  })

  it('an op sequenced before the op-level boundary existed still gates on its body boundary', async () => {
    await actorStore.transact(testDid, async (store) => {
      const record = post(ENGINEERING, 'Legacy post')
      await sequenceChange(store, {
        action: 'create',
        uri: `at://${testDid}/${COLLECTION}/gendo`,
        cid: (await computeCid(record)).toString(),
        record,
        commitCid:
          'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        rev: '3kaaaaaaaaaaa',
      })
    })

    const [event] = await readSeqEvents()
    const decoded = decodeEvent(event)
    expect((decoded.ops[0] as unknown as RawOp).boundary).toBeUndefined()
    expect(decoded.boundaries).toEqual([ENGINEERING])
    expect(eventInScope(decoded, new Set([ENGINEERING]))).toBe(true)
    expect(eventInScope(decoded, new Set([DESIGN]))).toBe(false)

    const pulled = await listRepoOps(
      ctx,
      { did: testDid, limit: 1000, excludeValues: false },
      new Set([ENGINEERING]),
    )
    expect(pulled.ops.map((op) => op.rkey)).toEqual(['gendo'])
    const pulledOutside = await listRepoOps(
      ctx,
      { did: testDid, limit: 1000, excludeValues: false },
      new Set([DESIGN]),
    )
    expect(pulledOutside.ops).toEqual([])
  })

  it('delivers the new op to a subscriber in its boundary and withholds it from one outside', async () => {
    await create('toji', post(ENGINEERING, 'Eva-00 prototype'))

    const [event] = await readSeqEvents()
    const decoded = decodeEvent(event)
    expect(eventInScope(decoded, new Set([ENGINEERING]))).toBe(true)
    expect(eventInScope(decoded, new Set([DESIGN]))).toBe(false)

    const inside = await listRepoOps(
      ctx,
      { did: testDid, limit: 1000, excludeValues: false },
      new Set([ENGINEERING]),
    )
    expect(inside.ops.map((op) => op.rkey)).toEqual(['toji'])
    const outside = await listRepoOps(
      ctx,
      { did: testDid, limit: 1000, excludeValues: false },
      new Set([DESIGN]),
    )
    expect(outside.ops).toEqual([])
  })

  it('gates on the op-level boundary when the body names none', async () => {
    await create('hikari', post(ENGINEERING, 'Class representative'))

    const [event] = await readSeqEvents()
    const rawEvent = decode(event.event) as Record<string, any>
    const rawOp = (
      Array.isArray(rawEvent.ops) ? rawEvent.ops[0] : rawEvent
    ) as RawOp
    delete rawOp.record?.boundary
    const withoutBodyBoundary: SeqEvent = { ...event, event: encode(rawEvent) }

    const decoded = decodeEvent(withoutBodyBoundary)
    expect(eventInScope(decoded, new Set([ENGINEERING]))).toBe(true)
    expect(eventInScope(decoded, new Set([DESIGN]))).toBe(false)
  })
})
