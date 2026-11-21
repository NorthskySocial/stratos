import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeCid,
  encodeRecord,
  stratosRecordBoundary,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context.js'
import { applyWritesBatch, updateRecord } from '../src/api/records/index.js'
import {
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const DOMAIN = 'did:web:nerv.tokyo.jp/engineering'
const COLLECTION = 'zone.stratos.feed.post'
const EXISTING_RKEY = 'unit01'
const NEW_RKEY = 'unit02'
const NOT_ENROLLED_MESSAGE = 'User is not enrolled in this Stratos service'
const SERVICE_WRITE_MESSAGE = 'Service identities cannot create records'

function post(text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: DOMAIN }],
    },
  }
}

describe('Update and batch writes require a writable enrollment', () => {
  let harness: WriteHarness
  let ctx: AppContext
  let actorStore: AppContext['actorStore']
  let getSignFn: ReturnType<typeof vi.spyOn>
  let emit: ReturnType<typeof vi.spyOn>

  const testDid = 'did:plc:shinji-ikari'

  async function enrollCaller(overrides: {
    active?: boolean
    isService?: boolean
  }) {
    await ctx.enrollmentStore.enroll({
      did: testDid,
      enrolledAt: '2026-01-01T00:00:00.000Z',
      boundaries: [DOMAIN],
      signingKeyDid: await ctx.actorSigner.getPublicKey(testDid),
      active: true,
      isService: false,
      custody: 'stratos',
      ...overrides,
    })
  }

  async function snapshotStore() {
    return actorStore.read(testDid, async (store) => {
      const boundaryRows = await (
        store.record as unknown as {
          reader: {
            db: {
              select: () => {
                from: (table: unknown) => Promise<unknown[]>
              }
            }
          }
        }
      ).reader.db
        .select()
        .from(stratosRecordBoundary)
      return {
        records: await store.record.listAll(),
        boundaryRows,
        root: await store.repo.getRootDetailed(),
        events: await store.sequence.getEventsSince(0, 1000),
      }
    })
  }

  function updateOp() {
    return {
      action: 'update' as const,
      collection: COLLECTION,
      rkey: EXISTING_RKEY,
      record: post('Edited by the pilot'),
    }
  }

  function createOp() {
    return {
      action: 'create' as const,
      collection: COLLECTION,
      rkey: NEW_RKEY,
      record: post('Launching Unit-02'),
    }
  }

  function updateCall() {
    return updateRecord(
      ctx,
      {
        repo: testDid,
        collection: COLLECTION,
        rkey: EXISTING_RKEY,
        record: post('Edited by the pilot'),
      },
      testDid,
    )
  }

  const rejectedEnrollments = [
    {
      title: 'a missing enrollment',
      seed: async () => {},
      expected: { error: 'NotEnrolled', message: NOT_ENROLLED_MESSAGE },
    },
    {
      title: 'an inactive enrollment',
      seed: () => enrollCaller({ active: false }),
      expected: { error: 'NotEnrolled', message: NOT_ENROLLED_MESSAGE },
    },
    {
      title: 'a service enrollment',
      seed: () => enrollCaller({ isService: true }),
      expected: {
        error: 'ServiceWriteForbidden',
        message: SERVICE_WRITE_MESSAGE,
      },
    },
  ]

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    ctx = harness.ctx
    actorStore = ctx.actorStore
    getSignFn = vi.spyOn(ctx.actorSigner, 'getSignFn')
    emit = vi.spyOn(ctx.sequenceEvents, 'emit')

    await actorStore.create(testDid)
    await actorStore.transact(testDid, async (store) => {
      const record = post('Original text')
      await store.record.indexRecord(
        `at://${testDid}/${COLLECTION}/${EXISTING_RKEY}`,
        await computeCid(record),
        record,
        'create',
        '3kseedrev0000',
      )
    })
  })

  afterEach(async () => {
    await harness.close()
  })

  describe.each(rejectedEnrollments)('with $title', ({ seed, expected }) => {
    it('rejects an update before signing or any store write', async () => {
      await seed()
      const before = await snapshotStore()

      await expect(updateCall()).rejects.toMatchObject(expected)

      expect(getSignFn).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(await snapshotStore()).toEqual(before)
    })

    it('rejects a batch of only creates before signing or any store write', async () => {
      await seed()
      const before = await snapshotStore()

      await expect(
        applyWritesBatch(ctx, testDid, [createOp()]),
      ).rejects.toMatchObject(expected)

      expect(getSignFn).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(await snapshotStore()).toEqual(before)
    })

    it('rejects a batch holding an update before signing or any store write', async () => {
      await seed()
      const before = await snapshotStore()

      await expect(
        applyWritesBatch(ctx, testDid, [updateOp()]),
      ).rejects.toMatchObject(expected)

      expect(getSignFn).not.toHaveBeenCalled()
      expect(emit).not.toHaveBeenCalled()
      expect(await snapshotStore()).toEqual(before)
    })
  })

  describe('with an active, stratos-custody, non-service enrollment', () => {
    beforeEach(async () => {
      await enrollCaller({})
    })

    it('still accepts an update', async () => {
      const before = await snapshotStore()
      const result = await updateCall()

      expect(result.uri).toBe(`at://${testDid}/${COLLECTION}/${EXISTING_RKEY}`)
      expect(getSignFn).toHaveBeenCalledWith(testDid)
      expect(emit).toHaveBeenCalledWith(testDid)
      const after = await snapshotStore()
      expect(after.root).not.toEqual(before.root)
    })

    it('still accepts a batch of creates', async () => {
      const result = await applyWritesBatch(ctx, testDid, [createOp()])

      expect(result.commit.rev).toEqual(expect.any(String))
      expect(emit).toHaveBeenCalledWith(testDid)
      const after = await snapshotStore()
      expect(after.records.map((record) => record.uri)).toContain(
        `at://${testDid}/${COLLECTION}/${NEW_RKEY}`,
      )
    })

    it('still accepts a batch holding an update', async () => {
      const before = await snapshotStore()
      await applyWritesBatch(ctx, testDid, [updateOp()])

      const after = await snapshotStore()
      expect(after.root).not.toEqual(before.root)
    })
  })
})
