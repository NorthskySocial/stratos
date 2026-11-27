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
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

import { StratosActorStore } from '../src/context.js'
import { getRecord, listRecords } from '../src/api/records/index.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { createEmptyLabelLog, createMockBlobStore } from './utils/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const DESIGN = `${SERVICE_DID}/design`
const LEADERSHIP = `${SERVICE_DID}/leadership`
const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const ENGINEERING_VIEWER_DID = 'did:plc:ritsuko-akagi'
const DESIGN_VIEWER_DID = 'did:plc:shigeru-aoba'
const LEADERSHIP_VIEWER_DID = 'did:plc:gendo-ikari'

const recordNotFound = {
  message: 'Record not found',
  customErrorName: 'RecordNotFound',
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

interface StoreHarness {
  actorStore: ActorStore
  cleanup: () => Promise<void>
}

function describeReadsFromBoundaryRows(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let ctx: {
      actorStore: ActorStore
      labelStore: ReturnType<typeof createEmptyLabelLog>
      logger: { warn: ReturnType<typeof vi.fn> }
    }

    beforeAll(async () => {
      harness = await openStore()
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    }, 60_000)

    beforeEach(async () => {
      ctx = {
        actorStore: harness.actorStore,
        labelStore: createEmptyLabelLog(),
        logger: { warn: vi.fn() },
      }
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

    function read(rkey: string, viewerDid?: string, viewerDomains?: string[]) {
      return getRecord(
        ctx as never,
        { repo: OWNER_DID, collection: COLLECTION, rkey },
        viewerDid,
        viewerDomains,
      )
    }

    async function listed(viewerDid?: string, viewerDomains?: string[]) {
      const result = await listRecords(
        ctx as never,
        { repo: OWNER_DID, collection: COLLECTION },
        viewerDid,
        viewerDomains,
      )
      return result.records.map((record) => record.uri)
    }

    describe('row without a body boundary', () => {
      beforeEach(async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)
      })

      it('serves getRecord to a viewer in the row boundary', async () => {
        const served = await read('angel', ENGINEERING_VIEWER_DID, [
          ENGINEERING,
        ])
        expect(served.uri).toBe(uriOf('angel'))
      })

      it('hides getRecord from a viewer outside the row boundary', async () => {
        await expect(
          read('angel', DESIGN_VIEWER_DID, [DESIGN]),
        ).rejects.toMatchObject(recordNotFound)
      })

      it('serves getRecord to the owner', async () => {
        const served = await read('angel', OWNER_DID)
        expect(served.uri).toBe(uriOf('angel'))
      })

      it('lists the record for a viewer in the row boundary', async () => {
        expect(await listed(ENGINEERING_VIEWER_DID, [ENGINEERING])).toEqual([
          uriOf('angel'),
        ])
      })

      it('omits the record from the list for a viewer outside the row boundary', async () => {
        expect(await listed(DESIGN_VIEWER_DID, [DESIGN])).toEqual([])
      })

      it('lists the record for the owner', async () => {
        expect(await listed(OWNER_DID)).toEqual([uriOf('angel')])
      })

      it('does not log the domainless invariant', async () => {
        await listed(ENGINEERING_VIEWER_DID, [ENGINEERING])
        await read('angel', ENGINEERING_VIEWER_DID, [ENGINEERING])
        expect(ctx.logger.warn).not.toHaveBeenCalled()
      })
    })

    describe('body claims a different boundary than the row', () => {
      beforeEach(async () => {
        await seed('shito', bodyClaiming('Zeruel', [LEADERSHIP]), ENGINEERING)
      })

      it('serves getRecord by the row boundary', async () => {
        const served = await read('shito', ENGINEERING_VIEWER_DID, [
          ENGINEERING,
        ])
        expect(served.uri).toBe(uriOf('shito'))
      })

      it('hides getRecord from a viewer who holds only the body boundary', async () => {
        await expect(
          read('shito', LEADERSHIP_VIEWER_DID, [LEADERSHIP]),
        ).rejects.toMatchObject(recordNotFound)
      })

      it('lists the record by the row boundary', async () => {
        expect(await listed(ENGINEERING_VIEWER_DID, [ENGINEERING])).toEqual([
          uriOf('shito'),
        ])
      })

      it('omits the record from the list for a viewer who holds only the body boundary', async () => {
        expect(await listed(LEADERSHIP_VIEWER_DID, [LEADERSHIP])).toEqual([])
      })
    })

    describe('record with no row and no body boundary', () => {
      beforeEach(async () => {
        await seed('lilith', bodyClaiming('Adam', []), null)
      })

      it('serves getRecord to the owner', async () => {
        const served = await read('lilith', OWNER_DID)
        expect(served.uri).toBe(uriOf('lilith'))
      })

      it('refuses getRecord to every other viewer', async () => {
        await expect(
          read('lilith', ENGINEERING_VIEWER_DID, [ENGINEERING]),
        ).rejects.toMatchObject(recordNotFound)
        await expect(read('lilith')).rejects.toMatchObject(recordNotFound)
      })

      it('omits the record from the list for other viewers and keeps it for the owner', async () => {
        expect(await listed(ENGINEERING_VIEWER_DID, [ENGINEERING])).toEqual([])
        expect(await listed(OWNER_DID)).toEqual([uriOf('lilith')])
      })

      it('logs the invariant once per list call', async () => {
        await listed(ENGINEERING_VIEWER_DID, [ENGINEERING])
        expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
        expect(ctx.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ domainlessCount: 1 }),
          expect.stringContaining('no domain'),
        )
      })
    })

    describe('taken-down record with a matching row', () => {
      beforeEach(async () => {
        await seed('leliel', bodyClaiming('Leliel', []), ENGINEERING)
        await harness.actorStore.transact(OWNER_DID, async (store) => {
          await store.record.updateRecordTakedown(uriOf('leliel'), {
            applied: true,
            ref: 'case-leliel',
          })
        })
      })

      it('hides getRecord from a viewer in the row boundary', async () => {
        await expect(
          read('leliel', ENGINEERING_VIEWER_DID, [ENGINEERING]),
        ).rejects.toMatchObject(recordNotFound)
      })

      it('hides getRecord from the owner', async () => {
        await expect(read('leliel', OWNER_DID)).rejects.toMatchObject(
          recordNotFound,
        )
      })

      it('omits the record from the list', async () => {
        expect(await listed(ENGINEERING_VIEWER_DID, [ENGINEERING])).toEqual([])
        expect(await listed(OWNER_DID)).toEqual([])
      })
    })
  })
}

describeReadsFromBoundaryRows('SQLite store', async () => {
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

describeReadsFromBoundaryRows('runtime Postgres store', async () => {
  const connectionString = await startPostgresContainer()
  const actorStore = new PostgresActorStore({
    connectionString,
    blobstore: createMockBlobStoreCreator(),
    cborToRecord,
  })
  return { actorStore, cleanup: () => stopPostgresContainer() }
})
