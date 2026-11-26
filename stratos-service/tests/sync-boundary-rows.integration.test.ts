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
import { computeCid } from '@northskysocial/stratos-core'

import { StratosActorStore } from '../src/context.js'
import type { AppContext } from '../src/context.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { sequenceChange } from '../src/api/records/index.js'
import { listRepoOps } from '../src/features/pull-sync/index.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import { decodeEvent, eventInScope } from '../src/subscription/index.js'
import { readSequencePage } from '../src/subscription/sequence-paging.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { createMockBlobStore } from './utils/index.js'

const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const ENGINEERING = 'did:web:nerv.tokyo.jp/engineering'
const DESIGN = 'did:web:nerv.tokyo.jp/design'
const LEADERSHIP = 'did:web:nerv.tokyo.jp/leadership'
const COMMIT_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

const engineeringCaller: ReadonlySet<string> = new Set([ENGINEERING])
const designCaller: ReadonlySet<string> = new Set([DESIGN])
const leadershipCaller: ReadonlySet<string> = new Set([LEADERSHIP])

function uriOf(rkey: string) {
  return `at://${OWNER_DID}/${COLLECTION}/${rkey}`
}

function bodyClaiming(text: string, boundary: string | null) {
  const body: Record<string, unknown> = {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
  }
  if (boundary !== null) {
    body.boundary = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    }
  }
  return body
}

interface StoreHarness {
  actorStore: ActorStore
  cleanup: () => Promise<void>
}

function describeSyncGating(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let ctx: AppContext
    let labelDir: string
    let serviceDb: ServiceDb
    let revCounter = 0

    beforeAll(async () => {
      harness = await openStore()
      labelDir = join(
        tmpdir(),
        `stratos-test-${randomBytes(8).toString('hex')}`,
      )
      await mkdir(labelDir, { recursive: true })
      const serviceDbPath = join(labelDir, 'service.sqlite')
      serviceDb = createServiceDb(serviceDbPath)
      await migrateServiceDb(serviceDb)
      ctx = {
        actorStore: harness.actorStore,
        labelStore: new SqliteLabelStore(serviceDb, serviceDbPath),
      } as unknown as AppContext
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
      await closeServiceDb(serviceDb)
      await rm(labelDir, { recursive: true, force: true })
    }, 60_000)

    beforeEach(async () => {
      revCounter = 0
      await harness.actorStore.create(OWNER_DID)
    })

    afterEach(async () => {
      await harness.actorStore.destroy(OWNER_DID)
    })

    async function sequenceCreate(
      rkey: string,
      body: Record<string, unknown>,
      opBoundary: string | null,
    ) {
      revCounter++
      const cid = (await computeCid(body)).toString()
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await sequenceChange(store, {
          action: 'create',
          uri: uriOf(rkey),
          cid,
          record: body,
          ...(opBoundary !== null
            ? { boundary: { values: [{ value: opBoundary }] } }
            : {}),
          commitCid: COMMIT_CID,
          rev: `3kaaaaaaaaa${String.fromCharCode(96 + revCounter)}2`,
        })
      })
    }

    async function streamDelivers(
      callerBoundaries: ReadonlySet<string>,
    ): Promise<string[]> {
      const events = await readSequencePage(ctx, OWNER_DID, 0)
      return events.flatMap((event) => {
        const decoded = decodeEvent(event)
        return eventInScope(decoded, callerBoundaries)
          ? decoded.ops.map((op) => op.path.split('/')[1])
          : []
      })
    }

    async function pulled(callerBoundaries: ReadonlySet<string>) {
      const page = await listRepoOps(
        ctx,
        { did: OWNER_DID, limit: 1000, excludeValues: false },
        callerBoundaries,
      )
      return page.ops.map((op) => op.rkey)
    }

    describe('op-level boundary with no boundary in the body', () => {
      beforeEach(async () => {
        await sequenceCreate(
          'sachiel',
          bodyClaiming('Sachiel', null),
          ENGINEERING,
        )
      })

      it('subscribeRecords delivers it to an engineering subscriber', async () => {
        expect(await streamDelivers(engineeringCaller)).toEqual(['sachiel'])
      })

      it('subscribeRecords withholds it from a design subscriber', async () => {
        expect(await streamDelivers(designCaller)).toEqual([])
      })

      it('listRepoOps returns it to an engineering caller', async () => {
        expect(await pulled(engineeringCaller)).toEqual(['sachiel'])
      })

      it('listRepoOps withholds it from a design caller', async () => {
        expect(await pulled(designCaller)).toEqual([])
      })
    })

    describe('op-level boundary that differs from the body boundary', () => {
      beforeEach(async () => {
        await sequenceCreate(
          'zeruel',
          bodyClaiming('Zeruel', LEADERSHIP),
          ENGINEERING,
        )
      })

      it('subscribeRecords delivers it to an engineering subscriber', async () => {
        expect(await streamDelivers(engineeringCaller)).toEqual(['zeruel'])
      })

      it('subscribeRecords withholds it from a leadership-only subscriber', async () => {
        expect(await streamDelivers(leadershipCaller)).toEqual([])
      })

      it('listRepoOps returns it to an engineering caller', async () => {
        expect(await pulled(engineeringCaller)).toEqual(['zeruel'])
      })

      it('listRepoOps withholds it from a leadership-only caller', async () => {
        expect(await pulled(leadershipCaller)).toEqual([])
      })
    })

    describe('op with only a body boundary', () => {
      beforeEach(async () => {
        await sequenceCreate(
          'ramiel',
          bodyClaiming('Ramiel', ENGINEERING),
          null,
        )
      })

      it('subscribeRecords delivers it to an engineering subscriber', async () => {
        expect(await streamDelivers(engineeringCaller)).toEqual(['ramiel'])
      })

      it('subscribeRecords withholds it from a design subscriber', async () => {
        expect(await streamDelivers(designCaller)).toEqual([])
      })

      it('listRepoOps returns it to an engineering caller', async () => {
        expect(await pulled(engineeringCaller)).toEqual(['ramiel'])
      })

      it('listRepoOps withholds it from a design caller', async () => {
        expect(await pulled(designCaller)).toEqual([])
      })
    })
  })
}

describeSyncGating('SQLite store', async () => {
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

describeSyncGating('runtime Postgres store', async () => {
  const connectionString = await startPostgresContainer()
  const actorStore = new PostgresActorStore({
    connectionString,
    blobstore: createMockBlobStoreCreator(),
    cborToRecord,
  })
  return { actorStore, cleanup: () => stopPostgresContainer() }
})
