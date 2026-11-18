import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { encodeRecord } from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context.js'
import {
  applyWritesBatch,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import { parentBoundaryCache } from '../src/api/records/validation.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { decodeEvent, type SeqEvent } from '../src/subscription/index.js'
import {
  createCid,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const LEADERSHIP = `${SERVICE_DID}/leadership`
const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'

interface RawOp {
  action: string
  path: string
  boundary?: { values: Array<{ value: string }> }
  excludeBoundary?: { values: Array<{ value: string }> }
}

function uriOf(rkey: string) {
  return `at://${OWNER_DID}/${COLLECTION}/${rkey}`
}

function bodyClaiming(text: string, boundaries: string[]) {
  const body: Record<string, unknown> = {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
  }
  if (boundaries.length > 0) {
    body.boundary = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    }
  }
  return body
}

function replyTo(parentUri: string) {
  return {
    reply: {
      parent: { uri: parentUri, cid: 'bafyparent' },
      root: { uri: parentUri, cid: 'bafyparent' },
    },
  }
}

function boundaryNames(op: RawOp | undefined) {
  return op?.boundary?.values.map((entry) => entry.value)
}

interface StoreHarness {
  write: WriteHarness
  cleanup: () => Promise<void>
}

function describeBoundaryRowsOnWrites(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let actorStore: ActorStore
    let ctx: AppContext

    beforeAll(async () => {
      harness = await openStore()
      ctx = harness.write.ctx
      actorStore = ctx.actorStore
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    }, 60_000)

    beforeEach(async () => {
      parentBoundaryCache.clear()
      await harness.write.enrollMember(OWNER_DID, [ENGINEERING, DESIGN])
    })

    afterEach(async () => {
      await ctx.enrollmentStore.unenroll(OWNER_DID)
      await actorStore.destroy(OWNER_DID)
    })

    async function seed(
      rkey: string,
      body: Record<string, unknown>,
      rowBoundary: string,
    ) {
      const content = encodeRecord(body)
      const cid = await createCid(content)
      await actorStore.transact(OWNER_DID, async (store) => {
        await store.record.putRecord({
          uri: uriOf(rkey),
          cid,
          value: body,
          content,
        })
        await store.record.indexRecordInBoundary(
          uriOf(rkey),
          cid,
          body,
          rowBoundary,
          'update',
          'rev-seed',
        )
      })
    }

    async function takeDown(rkey: string) {
      await actorStore.transact(OWNER_DID, async (store) => {
        await store.record.updateRecordTakedown(uriOf(rkey), {
          applied: true,
          ref: `case-${rkey}`,
        })
      })
    }

    async function storedBoundaries(rkey: string) {
      return actorStore.read(OWNER_DID, (store) =>
        store.record.getRecordBoundaries(uriOf(rkey)),
      )
    }

    async function sequencedOps(): Promise<RawOp[]> {
      const events = await actorStore.read(OWNER_DID, async (store: any) => {
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
      return events.flatMap(
        (event: SeqEvent) => decodeEvent(event).ops as unknown as RawOp[],
      )
    }

    async function removalOps() {
      return (await sequencedOps()).filter((op) => op.action === 'delete')
    }

    const writePaths = {
      'legacy update': (rkey: string, record: Record<string, unknown>) =>
        updateRecord(
          ctx,
          { repo: OWNER_DID, collection: COLLECTION, rkey, record },
          OWNER_DID,
        ),
      'batch update op': (rkey: string, record: Record<string, unknown>) =>
        applyWritesBatch(ctx, OWNER_DID, [
          { action: 'update', collection: COLLECTION, rkey, record },
        ] as never),
    }

    describe.each(Object.entries(writePaths))('%s', (_name, write) => {
      it('removes from the boundary stored in the row, not the one the body claims', async () => {
        await seed('shito', bodyClaiming('Zeruel', [LEADERSHIP]), ENGINEERING)

        await write('shito', bodyClaiming('Moved', [DESIGN]))

        const removals = await removalOps()
        expect(removals).toHaveLength(1)
        expect(boundaryNames(removals[0])).toEqual([ENGINEERING])
        expect(removals[0].excludeBoundary?.values).toEqual([{ value: DESIGN }])
        const scopedToLeadership = (await sequencedOps()).filter((op) =>
          boundaryNames(op)?.includes(LEADERSHIP),
        )
        expect(scopedToLeadership).toEqual([])
        expect(await storedBoundaries('shito')).toEqual([DESIGN])
      })

      it('removes a taken-down record from the boundary stored in its row', async () => {
        await seed('leliel', bodyClaiming('Leliel', [ENGINEERING]), ENGINEERING)
        await takeDown('leliel')

        await write('leliel', bodyClaiming('Moved', [DESIGN]))

        const removals = await removalOps()
        expect(removals).toHaveLength(1)
        expect(boundaryNames(removals[0])).toEqual([ENGINEERING])
        expect(removals[0].excludeBoundary?.values).toEqual([{ value: DESIGN }])
        expect(await storedBoundaries('leliel')).toEqual([DESIGN])
      })

      it('sequences no removal when the body and the row agree and the record stays', async () => {
        await seed('ramiel', bodyClaiming('Ramiel', [DESIGN]), DESIGN)

        await write('ramiel', bodyClaiming('Still here', [DESIGN]))

        expect(await removalOps()).toEqual([])
        expect(await storedBoundaries('ramiel')).toEqual([DESIGN])
      })

      it('sequences no removal when the record stays in the boundary of its row', async () => {
        await seed('sachiel', bodyClaiming('Sachiel', [LEADERSHIP]), DESIGN)

        await write('sachiel', bodyClaiming('Still here', [DESIGN]))

        expect(await removalOps()).toEqual([])
        expect(await storedBoundaries('sachiel')).toEqual([DESIGN])
      })
    })

    describe('reply parent boundaries', () => {
      function reply(rkey: string, boundary: string, parentRkey: string) {
        return createRecord(
          ctx,
          {
            repo: OWNER_DID,
            collection: COLLECTION,
            rkey,
            record: {
              ...bodyClaiming('Reply', [boundary]),
              ...replyTo(uriOf(parentRkey)),
            },
          },
          OWNER_DID,
        )
      }

      it('accepts a reply inside the boundary stored for a parent with no body boundary', async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)

        await expect(reply('r1', ENGINEERING, 'angel')).resolves.toMatchObject({
          uri: uriOf('r1'),
        })
      })

      it('rejects a reply outside the boundary stored for the parent', async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)

        await expect(reply('r2', DESIGN, 'angel')).rejects.toMatchObject({
          error: 'InvalidRecord',
        })
      })

      it('rejects a reply outside the stored boundary although the body names the reply boundary', async () => {
        await seed('shito', bodyClaiming('Zeruel', [DESIGN]), ENGINEERING)

        await expect(reply('r3', DESIGN, 'shito')).rejects.toMatchObject({
          error: 'InvalidRecord',
        })
      })

      it("a reply to a taken-down parent is not checked against the parent's boundary", async () => {
        await seed('leliel', bodyClaiming('Leliel', []), ENGINEERING)
        await takeDown('leliel')

        await expect(reply('r4', DESIGN, 'leliel')).resolves.toMatchObject({
          uri: uriOf('r4'),
        })
      })

      it("a reply to a missing parent is not checked against the parent's boundary", async () => {
        await expect(reply('r5', DESIGN, 'ghost')).resolves.toMatchObject({
          uri: uriOf('r5'),
        })
      })
    })
  })
}

describeBoundaryRowsOnWrites('SQLite store', async () => {
  const write = await startSqliteWriteHarness()
  return { write, cleanup: () => write.close() }
})

describeBoundaryRowsOnWrites('runtime Postgres store', async () => {
  const write = await startPostgresWriteHarness(await startPostgresContainer())
  return {
    write,
    cleanup: async () => {
      await write.close()
      await stopPostgresContainer()
    },
  }
})
