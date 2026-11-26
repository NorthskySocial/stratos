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
import {
  createEmptyLabelLog,
  createMockBlobStore,
  createTestConfig,
} from './utils/index.js'

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

const recordNotFound = {
  message: 'Record not found',
  customErrorName: 'RecordNotFound',
}
const notAdmitted = { message: 'Not admitted to this space' }

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

function describeSpaceReadFromBoundaryRows(
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
        `stratos-spaceread-rows-${randomBytes(8).toString('hex')}`,
      )
      await mkdir(dataDir, { recursive: true })
      db = createServiceDb(join(dataDir, 'service.sqlite'))
      await migrateServiceDb(db)
      enrollmentStore = new SqliteEnrollmentStore(db)

      const ctx = {
        cfg: createTestConfig(dataDir),
        actorStore: harness.actorStore,
        enrollmentStore,
        labelStore: createEmptyLabelLog(),
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
      handler = methods.get('zone.stratos.space.getRecord')!.handler

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

    function read(
      rkey: string,
      space: string,
      auth: { credentials: Record<string, unknown> },
    ) {
      return handler({
        params: { space, repo: OWNER_DID, collection: COLLECTION, rkey },
        auth,
        req: {},
        res: {},
      })
    }

    describe('row without a body boundary', () => {
      beforeEach(async () => {
        await seed('angel', bodyClaiming('Sachiel', []), ENGINEERING)
      })

      it('serves the record under the row boundary space to a credential', async () => {
        const res = await read(
          'angel',
          ENGINEERING_SPACE,
          credentialFor(ENGINEERING_SPACE),
        )
        expect(res.body.uri).toBe(uriOf('angel'))
      })

      it('serves the record under the row boundary space to a member', async () => {
        const res = await read(
          'angel',
          ENGINEERING_SPACE,
          userAuth(ENGINEERING_MEMBER_DID),
        )
        expect(res.body.uri).toBe(uriOf('angel'))
      })

      it('refuses the record under the design space key', async () => {
        await expect(
          read('angel', DESIGN_SPACE, credentialFor(DESIGN_SPACE)),
        ).rejects.toMatchObject(recordNotFound)
        await expect(
          read('angel', DESIGN_SPACE, userAuth(DESIGN_MEMBER_DID)),
        ).rejects.toMatchObject(recordNotFound)
      })

      it('refuses a design member who asks under the engineering space', async () => {
        await expect(
          read('angel', ENGINEERING_SPACE, userAuth(DESIGN_MEMBER_DID)),
        ).rejects.toMatchObject(notAdmitted)
      })
    })

    describe('body claims a different boundary than the row', () => {
      beforeEach(async () => {
        await seed('shito', bodyClaiming('Zeruel', [LEADERSHIP]), ENGINEERING)
      })

      it('serves the record under the row boundary space', async () => {
        const res = await read(
          'shito',
          ENGINEERING_SPACE,
          credentialFor(ENGINEERING_SPACE),
        )
        expect(res.body.uri).toBe(uriOf('shito'))
      })

      it('refuses the record under the body boundary space', async () => {
        await expect(
          read('shito', LEADERSHIP_SPACE, credentialFor(LEADERSHIP_SPACE)),
        ).rejects.toMatchObject(recordNotFound)
      })
    })

    describe('record with no row and no body boundary', () => {
      beforeEach(async () => {
        await seed('lilith', bodyClaiming('Adam', []), null)
      })

      it('fails closed under every space', async () => {
        await expect(
          read('lilith', ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
        ).rejects.toMatchObject(recordNotFound)
        await expect(
          read('lilith', DESIGN_SPACE, userAuth(DESIGN_MEMBER_DID)),
        ).rejects.toMatchObject(recordNotFound)
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

      it('hides the record from a credential and a member', async () => {
        await expect(
          read('leliel', ENGINEERING_SPACE, credentialFor(ENGINEERING_SPACE)),
        ).rejects.toMatchObject(recordNotFound)
        await expect(
          read('leliel', ENGINEERING_SPACE, userAuth(ENGINEERING_MEMBER_DID)),
        ).rejects.toMatchObject(recordNotFound)
      })
    })
  })
}

describeSpaceReadFromBoundaryRows('SQLite store', async () => {
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

describeSpaceReadFromBoundaryRows('runtime Postgres store', async () => {
  const connectionString = await startPostgresContainer()
  const actorStore = new PostgresActorStore({
    connectionString,
    blobstore: createMockBlobStoreCreator(),
    cborToRecord,
  })
  return { actorStore, cleanup: () => stopPostgresContainer() }
})
