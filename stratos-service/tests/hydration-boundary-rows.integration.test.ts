import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  encodeRecord,
  type HydrationService,
} from '@northskysocial/stratos-core'

import type { ActorStore } from '../src/actor-store-types.js'
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
const ENGINEERING_VIEWER_DID = 'did:plc:ritsuko-akagi'
const DESIGN_VIEWER_DID = 'did:plc:shigeru-aoba'
const LEADERSHIP_VIEWER_DID = 'did:plc:gendo-ikari'

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

interface BoundaryRowEditor {
  replaceRecordBoundaries(
    uri: string,
    boundaries: readonly string[],
  ): Promise<void>
}

// The SQLite wrapper keeps its core transactor private; Postgres is the transactor itself.
function boundaryRowEditor(record: unknown): BoundaryRowEditor {
  const wrapped = record as { transactor?: BoundaryRowEditor }
  return wrapped.transactor ?? (record as BoundaryRowEditor)
}

interface StoreHarness {
  write: WriteHarness
  cleanup: () => Promise<void>
}

function describeHydrationFromBoundaryRows(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let actorStore: ActorStore
    let service: HydrationService

    beforeAll(async () => {
      harness = await openStore()
      actorStore = harness.write.ctx.actorStore
      service = harness.write.ctx.hydrationService
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    })

    beforeEach(async () => {
      await actorStore.create(OWNER_DID)
    })

    afterEach(async () => {
      await actorStore.destroy(OWNER_DID)
    })

    async function seed(
      rkey: string,
      body: Record<string, unknown>,
      rowBoundary: string | null,
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
        if (rowBoundary !== null) {
          await store.record.indexRecordInBoundary(
            uriOf(rkey),
            cid,
            body,
            rowBoundary,
            'update',
            'rev-seed',
          )
        }
      })
    }

    async function deleteRows(rkey: string) {
      await actorStore.transact(OWNER_DID, async (store) => {
        await boundaryRowEditor(store.record).replaceRecordBoundaries(
          uriOf(rkey),
          [],
        )
      })
    }

    function viewerIn(viewerDid: string, boundary: string) {
      return { viewerDid, viewerDomains: [boundary] }
    }

    async function hydrateOne(
      rkey: string,
      context: { viewerDid: string | null; viewerDomains: string[] },
    ) {
      const result = await service.hydrateRecord({ uri: uriOf(rkey) }, context)
      return result.status
    }

    async function hydrateBatch(
      rkeys: string[],
      context: { viewerDid: string | null; viewerDomains: string[] },
    ) {
      const result = await service.hydrateRecords(
        rkeys.map((rkey) => ({ uri: uriOf(rkey) })),
        context,
      )
      return {
        served: result.records.map((record) => record.uri),
        blocked: result.blocked,
        notFound: result.notFound,
      }
    }

    describe('row without a body boundary', () => {
      beforeEach(async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)
      })

      it('hydrates a single record for a viewer in the row boundary', async () => {
        expect(
          await hydrateOne(
            'angel',
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toBe('success')
      })

      it('blocks a single record for a viewer outside the row boundary', async () => {
        expect(
          await hydrateOne('angel', viewerIn(DESIGN_VIEWER_DID, DESIGN)),
        ).toBe('blocked')
      })

      it('hydrates a batch record for a viewer in the row boundary', async () => {
        expect(
          await hydrateBatch(
            ['angel'],
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toEqual({ served: [uriOf('angel')], blocked: [], notFound: [] })
      })

      it('blocks a batch record for a viewer outside the row boundary', async () => {
        expect(
          await hydrateBatch(['angel'], viewerIn(DESIGN_VIEWER_DID, DESIGN)),
        ).toEqual({ served: [], blocked: [uriOf('angel')], notFound: [] })
      })
    })

    describe('body claims a different boundary than the row', () => {
      beforeEach(async () => {
        await seed('shito', bodyClaiming('Zeruel', [LEADERSHIP]), ENGINEERING)
      })

      it('follows the row for a single record', async () => {
        expect(
          await hydrateOne(
            'shito',
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toBe('success')
        expect(
          await hydrateOne(
            'shito',
            viewerIn(LEADERSHIP_VIEWER_DID, LEADERSHIP),
          ),
        ).toBe('blocked')
      })

      it('follows the row for a batch', async () => {
        expect(
          (
            await hydrateBatch(
              ['shito'],
              viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
            )
          ).served,
        ).toEqual([uriOf('shito')])
        expect(
          await hydrateBatch(
            ['shito'],
            viewerIn(LEADERSHIP_VIEWER_DID, LEADERSHIP),
          ),
        ).toEqual({ served: [], blocked: [uriOf('shito')], notFound: [] })
      })
    })

    describe('record with no row and no body boundary', () => {
      beforeEach(async () => {
        await seed('lilith', bodyClaiming('Adam', []), null)
      })

      it('hydrates for the owner and blocks every other viewer', async () => {
        expect(
          await hydrateOne('lilith', {
            viewerDid: OWNER_DID,
            viewerDomains: [],
          }),
        ).toBe('success')
        expect(
          await hydrateOne(
            'lilith',
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toBe('blocked')
        expect(
          await hydrateOne('lilith', { viewerDid: null, viewerDomains: [] }),
        ).toBe('blocked')
      })

      it('behaves the same in a batch', async () => {
        expect(
          await hydrateBatch(['lilith'], {
            viewerDid: OWNER_DID,
            viewerDomains: [],
          }),
        ).toEqual({ served: [uriOf('lilith')], blocked: [], notFound: [] })
        expect(
          await hydrateBatch(
            ['lilith'],
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toEqual({ served: [], blocked: [uriOf('lilith')], notFound: [] })
      })
    })

    describe('taken-down record with a matching row', () => {
      beforeEach(async () => {
        await seed('leliel', bodyClaiming('Leliel', []), ENGINEERING)
        await actorStore.transact(OWNER_DID, async (store) => {
          await store.record.updateRecordTakedown(uriOf('leliel'), {
            applied: true,
            ref: 'case-leliel',
          })
        })
      })

      it('reports a single record as not found', async () => {
        const viewer = viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING)
        const result = await service.hydrateRecord(
          { uri: uriOf('leliel') },
          viewer,
        )
        expect(result.status).toBe('not-found')
      })

      it('reports a batch record as not found', async () => {
        expect(
          await hydrateBatch(
            ['leliel'],
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toEqual({ served: [], blocked: [], notFound: [uriOf('leliel')] })
      })
    })

    describe('batch mixing row-only, body-only and domainless records', () => {
      beforeEach(async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)
        await seed('shito', bodyClaiming('Ramiel', [ENGINEERING]), null)
        await deleteRows('shito')
        await seed('lilith', bodyClaiming('Adam', []), null)
      })

      it('serves the row-only record and blocks the other two for engineering', async () => {
        expect(
          await hydrateBatch(
            ['angel', 'shito', 'lilith'],
            viewerIn(ENGINEERING_VIEWER_DID, ENGINEERING),
          ),
        ).toEqual({
          served: [uriOf('angel')],
          blocked: [uriOf('shito'), uriOf('lilith')],
          notFound: [],
        })
      })

      it('blocks all three for design', async () => {
        expect(
          await hydrateBatch(
            ['angel', 'shito', 'lilith'],
            viewerIn(DESIGN_VIEWER_DID, DESIGN),
          ),
        ).toEqual({
          served: [],
          blocked: [uriOf('angel'), uriOf('shito'), uriOf('lilith')],
          notFound: [],
        })
      })
    })
  })
}

describeHydrationFromBoundaryRows('SQLite store', async () => {
  const write = await startSqliteWriteHarness()
  return { write, cleanup: () => write.close() }
})

describeHydrationFromBoundaryRows('runtime Postgres store', async () => {
  const write = await startPostgresWriteHarness(await startPostgresContainer())
  return {
    write,
    cleanup: async () => {
      await write.close()
      await stopPostgresContainer()
    },
  }
})
