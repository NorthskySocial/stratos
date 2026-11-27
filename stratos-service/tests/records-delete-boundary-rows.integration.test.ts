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
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import express from 'express'
import { Lexicons } from '@atproto/lexicon'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import {
  createServiceJwt,
  Server as XrpcServer,
  Subscription,
} from '@atproto/xrpc-server'
import { stratosLexicons } from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import type { AppContext } from '../src/context.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { applyWritesBatch, deleteRecord } from '../src/api/records/index.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import { EnrollmentBoundaryResolver } from '../src/features/enrollment/index.js'
import { SqliteLabelStore } from '../src/features/moderation/index.js'
import { createSubscribeAuthVerifier } from '../src/infra/auth/verifiers.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
import {
  decodeEvent,
  registerSubscribeRecords,
  type SeqEvent,
} from '../src/subscription/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING_NAME = 'engineering'
const DESIGN_NAME = 'design'
const LEADERSHIP_NAME = 'leadership'
const ENGINEERING = `${SERVICE_DID}/${ENGINEERING_NAME}`
const DESIGN = `${SERVICE_DID}/${DESIGN_NAME}`
const LEADERSHIP = `${SERVICE_DID}/${LEADERSHIP_NAME}`
const COLLECTION = 'zone.stratos.feed.post'
const OWNER_DID = 'did:plc:misato-katsuragi'
const SUBSCRIBER_DID = 'did:web:geofront.tokyo.jp'
const SUBSCRIBE_METHOD = 'zone.stratos.sync.subscribeRecords'
const FRAME_TIMEOUT_MS = 10_000

interface RawOp {
  action: string
  path: string
  boundary?: { values: Array<{ value: string }> }
}

const uriOf = (rkey: string) => `at://${OWNER_DID}/${COLLECTION}/${rkey}`

function bodyClaiming(text: string, boundaries: string[]) {
  const body: Record<string, unknown> = {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
  }
  if (boundaries.length > 0) {
    body.boundary = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    }
  }
  return body
}

const boundaryNames = (op: RawOp | undefined) =>
  op?.boundary?.values.map((entry) => entry.value)

function didDocumentFor(keypair: Secp256k1Keypair) {
  return {
    id: keypair.did(),
    verificationMethod: [
      {
        id: `${keypair.did()}#key`,
        type: 'Multikey',
        controller: keypair.did(),
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
  }
}

interface StoreHarness {
  actorStore: ActorStore
  cleanup: () => Promise<void>
}

function describeDeleteBoundaryRows(
  label: string,
  openStore: () => Promise<StoreHarness>,
) {
  describe(label, () => {
    let harness: StoreHarness
    let dataDir: string
    let db: ServiceDb
    let enrollmentStore: SqliteEnrollmentStore
    let repoWriteLocks: RepoWriteLocks
    let ctx: AppContext
    let subscriberKey: Secp256k1Keypair
    let httpServer: http.Server

    beforeAll(async () => {
      harness = await openStore()
    }, 120_000)

    afterAll(async () => {
      await harness.cleanup()
    }, 60_000)

    beforeEach(async () => {
      dataDir = join(
        tmpdir(),
        `stratos-delete-rows-${randomBytes(8).toString('hex')}`,
      )
      await mkdir(dataDir, { recursive: true })
      db = createServiceDb(join(dataDir, 'service.sqlite'))
      await migrateServiceDb(db)
      enrollmentStore = new SqliteEnrollmentStore(db)
      repoWriteLocks = new RepoWriteLocks()
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      }
      const cfg = createTestConfig(dataDir)
      cfg.stratos.serviceDid = SERVICE_DID
      cfg.stratos.allowedDomains = [
        ENGINEERING_NAME,
        DESIGN_NAME,
        LEADERSHIP_NAME,
      ]

      await enrollmentStore.enroll({
        did: OWNER_DID,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: OWNER_DID,
      })
      await enrollmentStore.setBoundaries(OWNER_DID, [ENGINEERING])
      await enrollmentStore.enroll({
        did: SUBSCRIBER_DID,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: SUBSCRIBER_DID,
        isService: true,
      })
      await enrollmentStore.setBoundaries(SUBSCRIBER_DID, [DESIGN])

      subscriberKey = await Secp256k1Keypair.create()
      const idResolver = {
        did: {
          resolve: async (did: string) =>
            did === SUBSCRIBER_DID ? didDocumentFor(subscriberKey) : undefined,
        },
      } as unknown as IdResolver

      ctx = {
        cfg,
        actorStore: harness.actorStore,
        enrollmentStore,
        boundaryResolver: new EnrollmentBoundaryResolver(enrollmentStore),
        labelStore: new SqliteLabelStore(db, join(dataDir, 'service.sqlite')),
        serviceDid: SERVICE_DID,
        sequenceEvents: new EventEmitter(),
        enrollmentEvents: new EventEmitter(),
        writeRateLimiter: { assertWriteAllowed: vi.fn() },
        actorSigner: {
          getSignFn: vi
            .fn()
            .mockResolvedValue(() => Promise.resolve(new Uint8Array(64))),
        },
        repoWriteLocks,
        logger,
        xrpcServer: new XrpcServer(stratosLexicons),
        authVerifier: {
          subscribeAuth: createSubscribeAuthVerifier(idResolver, SERVICE_DID),
        },
      } as unknown as AppContext
      registerSubscribeRecords(ctx)
      const app = express()
      app.use(ctx.xrpcServer.router)
      httpServer = app.listen(0)

      await harness.actorStore.create(OWNER_DID)
    })

    afterEach(async () => {
      await harness.actorStore.destroy(OWNER_DID)
      repoWriteLocks.destroy()
      await new Promise((resolve) => httpServer.close(resolve))
      await closeServiceDb(db)
      await rm(dataDir, { recursive: true, force: true })
    })

    async function seedBodyOnly(rkey: string, body: Record<string, unknown>) {
      const content = new TextEncoder().encode(JSON.stringify(body))
      const cid = await createCid(content)
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await store.record.putRecord({
          uri: uriOf(rkey),
          cid,
          value: body,
          content,
        })
      })
      return cid
    }

    async function seed(
      rkey: string,
      body: Record<string, unknown>,
      rowBoundary: string,
    ) {
      const cid = await seedBodyOnly(rkey, body)
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await store.record.indexRecordInBoundary(
          uriOf(rkey),
          cid,
          body,
          rowBoundary,
          'update',
          'rev-seed',
        )
      })
      return cid.toString()
    }

    async function takeDown(rkey: string) {
      await harness.actorStore.transact(OWNER_DID, async (store) => {
        await store.record.updateRecordTakedown(uriOf(rkey), {
          applied: true,
          ref: `case-${rkey}`,
        })
      })
    }

    const storedBoundaries = (rkey: string) =>
      harness.actorStore.read(OWNER_DID, (store) =>
        store.record.getRecordBoundaries(uriOf(rkey)),
      )

    const storedRecord = (rkey: string) =>
      harness.actorStore.read(OWNER_DID, (store) =>
        store.record.getRecord(uriOf(rkey), null, true),
      )

    async function sequencedOps(): Promise<RawOp[]> {
      const events = await harness.actorStore.read(
        OWNER_DID,
        async (store: any) => {
          const rows = await store.sequence.getEventsSince(0, 1000)
          return rows.map((row: any): SeqEvent => ({
            seq: row.seq,
            did: row.did,
            time: row.sequencedAt,
            rev: row.rev ?? '',
            event: row.event,
          }))
        },
      )
      return events.flatMap(
        (event: SeqEvent) => decodeEvent(event).ops as unknown as RawOp[],
      )
    }

    const deleteOps = async () =>
      (await sequencedOps()).filter((op) => op.action === 'delete')

    const deletePaths: Record<
      string,
      (rkey: string, swapRecord?: string) => Promise<unknown>
    > = {
      'legacy deleteRecord': (rkey, swapRecord) =>
        deleteRecord(
          ctx,
          { repo: OWNER_DID, collection: COLLECTION, rkey, swapRecord },
          OWNER_DID,
        ),
      'batch delete op': (rkey) =>
        applyWritesBatch(ctx, OWNER_DID, [
          { action: 'delete', collection: COLLECTION, rkey },
        ] as never),
    }

    describe.each(Object.entries(deletePaths))('%s', (_name, remove) => {
      it('scopes the delete event to the boundary stored in the row, not the one the body claims', async () => {
        await seed('shito', bodyClaiming('Zeruel', [LEADERSHIP]), ENGINEERING)

        await remove('shito')

        const scoped = (await deleteOps()).filter((op) => op.boundary)
        expect(scoped).toHaveLength(1)
        expect(boundaryNames(scoped[0])).toEqual([ENGINEERING])
        const scopedToLeadership = (await sequencedOps()).filter((op) =>
          boundaryNames(op)?.includes(LEADERSHIP),
        )
        expect(scopedToLeadership).toEqual([])
      })

      it('sends a taken-down record delete event scoped to the boundary of its row', async () => {
        const cid = await seed(
          'leliel',
          bodyClaiming('Leliel', [LEADERSHIP]),
          ENGINEERING,
        )
        await takeDown('leliel')

        await remove('leliel', cid)

        const scoped = (await deleteOps()).filter((op) => op.boundary)
        expect(scoped).toHaveLength(1)
        expect(boundaryNames(scoped[0])).toEqual([ENGINEERING])
        expect(await storedRecord('leliel')).toBeNull()
      })

      it('sends no boundary-scoped delete for a record with no row and no body boundary', async () => {
        await seedBodyOnly('ramiel', bodyClaiming('Ramiel', []))
        expect(await storedBoundaries('ramiel')).toEqual([])

        await remove('ramiel')

        const scoped = (await deleteOps()).filter((op) => op.boundary)
        expect(scoped).toEqual([])
        expect(await storedRecord('ramiel')).toBeNull()
      })

      it('removes the record row and its boundary rows', async () => {
        await seed('gaghiel', bodyClaiming('Gaghiel', [DESIGN]), ENGINEERING)
        expect(await storedBoundaries('gaghiel')).toEqual([ENGINEERING])

        await remove('gaghiel')

        expect(await storedRecord('gaghiel')).toBeNull()
        expect(await storedBoundaries('gaghiel')).toEqual([])
      })

      it('delivers a delete with two boundaries to a websocket subscriber in one of them, and the frame passes lexicon validation', async () => {
        await seedBodyOnly(
          'israfel',
          bodyClaiming('Israfel', [DESIGN, ENGINEERING]),
        )
        expect(await storedBoundaries('israfel')).toEqual([DESIGN, ENGINEERING])
        // A delete is judged against every boundary the record is stored in.
        await enrollmentStore.setBoundaries(OWNER_DID, [ENGINEERING, DESIGN])

        await remove('israfel')

        const lexicons = new Lexicons(stratosLexicons)
        const abortController = new AbortController()
        const { port } = httpServer.address() as { port: number }
        const jwt = await createServiceJwt({
          iss: SUBSCRIBER_DID,
          aud: SERVICE_DID,
          lxm: SUBSCRIBE_METHOD,
          keypair: subscriberKey,
        })
        const subscription = new Subscription<Record<string, unknown>>({
          service: `ws://127.0.0.1:${port}`,
          method: SUBSCRIBE_METHOD,
          headers: { authorization: `Bearer ${jwt}` },
          signal: abortController.signal,
          getParams: () => ({ did: OWNER_DID, cursor: 0 }),
          validate: (frame) => {
            lexicons.assertValidXrpcMessage(SUBSCRIBE_METHOD, frame)
            return frame as Record<string, unknown>
          },
        })

        const received: RawOp[] = []
        const timer = setTimeout(
          () => abortController.abort(),
          FRAME_TIMEOUT_MS,
        )
        try {
          for await (const frame of subscription) {
            const ops = (frame.ops ?? []) as RawOp[]
            received.push(...ops)
            if (ops.some((op) => op.action === 'delete' && op.boundary)) break
          }
        } finally {
          clearTimeout(timer)
          abortController.abort()
        }

        const delivered = received.find(
          (op) => op.action === 'delete' && op.boundary,
        )
        expect(delivered?.path).toBe(`${COLLECTION}/israfel`)
        expect(boundaryNames(delivered)).toEqual([DESIGN, ENGINEERING])
      })
    })
  })
}

describeDeleteBoundaryRows('SQLite store', async () => {
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

describeDeleteBoundaryRows('runtime Postgres store', async () => {
  const connectionString = await startPostgresContainer()
  const actorStore = new PostgresActorStore({
    connectionString,
    blobstore: createMockBlobStoreCreator(),
    cborToRecord,
  })
  return { actorStore, cleanup: () => stopPostgresContainer() }
})
