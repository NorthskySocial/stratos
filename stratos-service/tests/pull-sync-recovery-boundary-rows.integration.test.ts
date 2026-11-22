import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { StratosActorStore } from '../src/context.js'
import type { AppContext } from '../src/context.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { listRecordPaths } from '../src/features/pull-sync/recovery.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { createEmptyLabelLog, createMockBlobStore } from './utils/index.js'

const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
const DESIGN = 'did:web:nerv.tokyo.jp/design'
const LEADERSHIP = 'did:web:nerv.tokyo.jp/leadership'

const engineeringCaller: ReadonlySet<string> = new Set([ENGINEERING])
const designCaller: ReadonlySet<string> = new Set([DESIGN])

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
  actorStore: ActorStore
  cleanup: () => Promise<void>
}

function describeRecoveryFromBoundaryRows(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let ctx: AppContext

    beforeAll(async () => {
      harness = await openStore()
      ctx = {
        actorStore: harness.actorStore,
        labelStore: createEmptyLabelLog(),
      } as unknown as AppContext
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    }, 60_000)

    beforeEach(async () => {
      await harness.actorStore.create(OWNER_DID)
    })

    afterEach(async () => {
      await harness.actorStore.destroy(OWNER_DID)
    })

    async function seed(
      rkey: string,
      body: Record<string, unknown>,
      rowBoundary: string | null,
    ) {
      const content = new TextEncoder().encode(JSON.stringify(body))
      const cid = await createCid(content)
      await harness.actorStore.transact(OWNER_DID, async (store) => {
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

    async function listed(
      callerBoundaries: ReadonlySet<string>,
      overrides: { limit?: number; cursor?: string } = {},
    ) {
      return listRecordPaths(
        ctx,
        { did: OWNER_DID, limit: 100, excludeValues: false, ...overrides },
        callerBoundaries,
      )
    }

    async function rkeysOf(callerBoundaries: ReadonlySet<string>) {
      return (await listed(callerBoundaries)).records.map((r) => r.rkey)
    }

    describe('row without a body boundary', () => {
      beforeEach(async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)
      })

      it('lists the path for an engineering caller', async () => {
        expect(await rkeysOf(engineeringCaller)).toEqual(['angel'])
      })

      it('hides the path from a design caller', async () => {
        expect(await rkeysOf(designCaller)).toEqual([])
      })
    })

    describe('body claims a different boundary than the row', () => {
      beforeEach(async () => {
        await seed('shito', bodyClaiming('Zeruel', [LEADERSHIP]), ENGINEERING)
      })

      it('follows the row for an engineering caller', async () => {
        expect(await rkeysOf(engineeringCaller)).toEqual(['shito'])
      })

      it('ignores the body claim for a leadership caller', async () => {
        expect(await rkeysOf(new Set([LEADERSHIP]))).toEqual([])
      })
    })

    describe('record with no row and no body boundary', () => {
      it('is not listed for any caller', async () => {
        await seed('lilith', bodyClaiming('Adam', []), null)
        expect(await rkeysOf(engineeringCaller)).toEqual([])
        expect(await rkeysOf(designCaller)).toEqual([])
      })
    })

    describe('record whose body names a boundary but has no row', () => {
      it('is not listed, because the row is the source', async () => {
        await seed('ramiel', bodyClaiming('Ramiel', [ENGINEERING]), null)
        await harness.actorStore.transact(OWNER_DID, async (store) => {
          await boundaryRowEditor(store.record).replaceRecordBoundaries(
            uriOf('ramiel'),
            [],
          )
        })
        expect(await rkeysOf(engineeringCaller)).toEqual([])
      })
    })

    describe('taken-down record with a matching row', () => {
      it('stays hidden', async () => {
        await seed('leliel', bodyClaiming('Leliel', []), ENGINEERING)
        await harness.actorStore.transact(OWNER_DID, async (store) => {
          await store.record.updateRecordTakedown(uriOf('leliel'), {
            applied: true,
            ref: 'case-leliel',
          })
        })
        expect(await rkeysOf(engineeringCaller)).toEqual([])
      })
    })

    describe('paging a mixed set', () => {
      beforeEach(async () => {
        await seed('a-sachiel', bodyClaiming('Sachiel', []), ENGINEERING)
        await seed(
          'b-shamshel',
          bodyClaiming('Shamshel', [ENGINEERING]),
          DESIGN,
        )
        await seed('c-ramiel', bodyClaiming('Ramiel', []), ENGINEERING)
        await seed('d-gaghiel', bodyClaiming('Gaghiel', []), null)
        await seed('e-israfel', bodyClaiming('Israfel', []), ENGINEERING)
      })

      it('walks every engineering row once across pages', async () => {
        // Postgres lists descending and SQLite ascending, so compare as a set.
        const seen: string[] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await listed(engineeringCaller, { limit: 2, cursor })
          expect(page.records.length).toBeLessThanOrEqual(2)
          seen.push(...page.records.map((r) => r.rkey))
          cursor = page.cursor
          pages++
        } while (cursor !== undefined && pages < 10)

        expect(cursor).toBeUndefined()
        expect([...seen].sort()).toEqual(['a-sachiel', 'c-ramiel', 'e-israfel'])
      })

      it('lists only the design row for a design caller', async () => {
        expect(await rkeysOf(designCaller)).toEqual(['b-shamshel'])
      })
    })
  })
}

describeRecoveryFromBoundaryRows('SQLite store', async () => {
  const dataDir = join(
    tmpdir(),
    `stratos-test-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(dataDir, { recursive: true })
  const actorStore = new StratosActorStore({
    dataDir,
    blobstore: () => createMockBlobStore(),
    cborToRecord: (content) => JSON.parse(new TextDecoder().decode(content)),
  })
  return {
    actorStore: actorStore as unknown as ActorStore,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  }
})

describeRecoveryFromBoundaryRows('runtime Postgres store', async () => {
  const connectionString = await startPostgresContainer()
  const actorStore = new PostgresActorStore({
    connectionString,
    blobstore: createMockBlobStoreCreator(),
    cborToRecord,
  })
  return { actorStore, cleanup: () => stopPostgresContainer() }
})
