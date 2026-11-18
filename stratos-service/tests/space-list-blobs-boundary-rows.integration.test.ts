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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { parseCid } from '@atproto/lex-data'
import { spaceUriToBoundary } from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import type { ActorStore } from '../src/actor-store-types.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { registerSpaceReadHandlers } from '../src/features/space-read/handler.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { makeSpaceUri } from './helpers/space-uri.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const SPACE_TYPE = 'zone.stratos.space.feed'
const ENGINEERING_SPACE = makeSpaceUri(SERVICE_DID, SPACE_TYPE, 'engineering')
const DESIGN_SPACE = makeSpaceUri(SERVICE_DID, SPACE_TYPE, 'design')
const LEADERSHIP_SPACE = makeSpaceUri(SERVICE_DID, SPACE_TYPE, 'leadership')
const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const ENGINEERING_MEMBER_DID = 'did:plc:ritsuko-akagi'
const DESIGN_MEMBER_DID = 'did:plc:shigeru-aoba'

function boundaryOf(space: string): string {
  const boundary = spaceUriToBoundary(space, SERVICE_DID)
  if (!boundary.ok) throw new Error('bad space fixture')
  return boundary.value
}

const ENGINEERING = boundaryOf(ENGINEERING_SPACE)
const DESIGN = boundaryOf(DESIGN_SPACE)
const LEADERSHIP = boundaryOf(LEADERSHIP_SPACE)

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

const credentialFor = (spaceUri: string) => ({
  credentials: { type: 'space-credential', spaceUri },
})
const userAuth = (did: string) => ({ credentials: { type: 'user', did } })

interface StoreHarness {
  actorStore: ActorStore
  cleanup: () => Promise<void>
}

function describeListBlobsFromBoundaryRows(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let dataDir: string
    let db: ServiceDb
    let enrollmentStore: SqliteEnrollmentStore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handler: any

    beforeAll(async () => {
      harness = await openStore()
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    }, 60_000)

    beforeEach(async () => {
      dataDir = join(
        tmpdir(),
        `stratos-listblobs-rows-${randomBytes(8).toString('hex')}`,
      )
      await mkdir(dataDir, { recursive: true })
      db = createServiceDb(join(dataDir, 'service.sqlite'))
      await migrateServiceDb(db)
      enrollmentStore = new SqliteEnrollmentStore(db)

      const ctx = {
        cfg: createTestConfig(dataDir),
        actorStore: harness.actorStore,
        enrollmentStore,
        serviceDid: SERVICE_DID,
        authVerifier: { standardOrSpaceCredential: vi.fn() },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          error: vi.fn(),
          warn: vi.fn(),
        },
      }
      const methods = new Map<string, { handler: unknown }>()
      const server = {
        method: (name: string, methodConfig: { handler: unknown }) =>
          methods.set(name, methodConfig),
      }
      registerSpaceReadHandlers(server as never, ctx as never)
      handler = methods.get('zone.stratos.space.listBlobs')!.handler

      for (const [did, boundary] of [
        [ENGINEERING_MEMBER_DID, ENGINEERING],
        [DESIGN_MEMBER_DID, DESIGN],
      ] as const) {
        await enrollmentStore.enroll({
          did,
          enrolledAt: new Date().toISOString(),
          active: true,
          signingKeyDid: 'did:key:zTest',
        })
        await enrollmentStore.setBoundaries(did, [boundary])
      }

      await harness.actorStore.create(OWNER_DID)
    })

    afterEach(async () => {
      await harness.actorStore.destroy(OWNER_DID)
      await closeServiceDb(db)
      await rm(dataDir, { recursive: true, force: true })
    })

    async function seedBlob(name: string): Promise<string> {
      const bytes = new TextEncoder().encode(`blob ${name}`)
      const cid = await createCid(bytes)
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await store.blob.trackBlob({
          cid,
          mimeType: 'image/png',
          size: bytes.length,
        })
      })
      return cid.toString()
    }

    async function seedRecord(
      rkey: string,
      body: Record<string, unknown>,
      rowBoundary: string | null,
      blob: string,
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
        await store.blob.associateBlobWithRecord(parseCid(blob), uriOf(rkey))
      })
    }

    async function listed(
      space: string,
      auth: { credentials: Record<string, unknown> },
    ): Promise<string[]> {
      const res = await handler({
        params: { space, repo: OWNER_DID },
        auth,
        req: {},
        res: {},
      })
      return res.body.cids
    }

    it('lists a blob of a row-only record for the row boundary and not for another', async () => {
      const blob = await seedBlob('sachiel')
      await seedRecord('angel', bodyClaiming('Sachiel', []), ENGINEERING, blob)
      expect(
        await listed(ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
      ).toEqual([blob])
      expect(
        await listed(ENGINEERING_SPACE, userAuth(ENGINEERING_MEMBER_DID)),
      ).toEqual([blob])
      expect(await listed(DESIGN_SPACE, credentialFor(DESIGN_SPACE))).toEqual(
        [],
      )
      expect(await listed(DESIGN_SPACE, userAuth(DESIGN_MEMBER_DID))).toEqual(
        [],
      )
    })

    it('follows the row when the body claims another boundary', async () => {
      const blob = await seedBlob('zeruel')
      await seedRecord(
        'shito',
        bodyClaiming('Zeruel', [LEADERSHIP]),
        ENGINEERING,
        blob,
      )
      expect(
        await listed(ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
      ).toEqual([blob])
      expect(
        await listed(LEADERSHIP_SPACE, credentialFor(LEADERSHIP_SPACE)),
      ).toEqual([])
    })

    it('lists nothing for a record with no row and no body boundary', async () => {
      const blob = await seedBlob('adam')
      await seedRecord('lilith', bodyClaiming('Adam', []), null, blob)
      expect(
        await listed(ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
      ).toEqual([])
      expect(await listed(DESIGN_SPACE, credentialFor(DESIGN_SPACE))).toEqual(
        [],
      )
    })

    it('omits the blob of a taken-down record', async () => {
      const blob = await seedBlob('leliel')
      await seedRecord('leliel', bodyClaiming('Leliel', []), ENGINEERING, blob)
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await store.record.updateRecordTakedown(uriOf('leliel'), {
          applied: true,
          ref: 'case-leliel',
        })
      })
      expect(
        await listed(ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
      ).toEqual([])
    })

    it('omits a taken-down blob but keeps the live one', async () => {
      const gone = await seedBlob('bardiel')
      const live = await seedBlob('ramiel')
      await seedRecord('gone', bodyClaiming('Bardiel', []), ENGINEERING, gone)
      await seedRecord('live', bodyClaiming('Ramiel', []), ENGINEERING, live)
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await store.blob.updateBlobTakedown(parseCid(gone), {
          applied: true,
          ref: 'case-bardiel',
        })
      })
      expect(
        await listed(ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
      ).toEqual([live])
    })
  })
}

describeListBlobsFromBoundaryRows('SQLite store', async () => {
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

describeListBlobsFromBoundaryRows('runtime Postgres store', async () => {
  const connectionString = await startPostgresContainer()
  const actorStore = new PostgresActorStore({
    connectionString,
    blobstore: createMockBlobStoreCreator(),
    cborToRecord,
  })
  return { actorStore, cleanup: () => stopPostgresContainer() }
})
