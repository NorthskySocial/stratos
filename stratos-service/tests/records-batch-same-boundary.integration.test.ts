import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeCid, encodeRecord } from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context.js'
import { applyWritesBatch } from '../src/api/records/index.js'
import { decodeEvent, type SeqEvent } from '../src/subscription/index.js'
import {
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

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
  let harness: WriteHarness
  let ctx: AppContext
  let actorStore: AppContext['actorStore']

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
    harness = await startSqliteWriteHarness()
    ctx = harness.ctx
    actorStore = ctx.actorStore
    await harness.enrollMember(testDid, [ENGINEERING, DESIGN])
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
    await harness.close()
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
