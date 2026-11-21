import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import axios, { type AxiosResponse } from 'axios'
import express from 'express'
import { decode } from '@atcute/cbor'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  computeCid,
  encodeRecord,
  parseCid,
  RECORD_SUBJECT_TYPE,
  spaceUriToBoundary,
  stratosLexicons,
} from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import type { AppContext } from '../src/context-types.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import {
  registerModerationHandlers,
  SqliteLabelStore,
} from '../src/features/moderation/index.js'
import { registerSpaceReadHandlers } from '../src/features/space-read/handler.js'
import {
  HydrationServiceImpl,
  registerHydrationHandlers,
} from '../src/features/hydration/index.js'
import { ActorStoreRecordResolver } from '../src/features/hydration/adapter.js'
import { BlobAuthServiceImpl } from '../src/features/blob/index.js'
import { EnrollmentBoundaryResolver } from '../src/features/enrollment/adapter.js'
import { listRecordPaths } from '../src/features/pull-sync/index.js'
import {
  getBlobHandler,
  getRecordHandler,
  listRecordsHandler,
} from '../src/api/handlers/index.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { SqliteAdminSessionStore } from '../src/oauth/admin-session-store.js'
import { SqliteAdminUserStore } from '../src/oauth/admin-user-store.js'
import { createMockBlobStore, createTestConfig } from './utils'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const CREATE_LABEL_NSID = 'zone.stratos.moderation.createLabel'
const POST_COLLECTION = 'zone.stratos.feed.post'
const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'
const SPACE_URI = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'nerv')

const AUTHOR_DID = 'did:plc:shinji-ikari'
const MEMBER_DID = 'did:plc:misato-katsuragi'
const FIRST_RKEY = 'eva-unit-01'
const SECOND_RKEY = 'eva-unit-02'

const MEMBER_AUTH = { credentials: { type: 'user', did: MEMBER_DID } }

type HandlerResult = { encoding: string; body: unknown }
type Handler = (args: Record<string, unknown>) => Promise<HandlerResult>

interface RecordBody {
  uri: string
  cid: string
  value: { text: string }
}

interface ListedBody {
  records: Array<{ uri: string }>
}

const boundaryResult = spaceUriToBoundary(SPACE_URI, SERVICE_DID)
if (!boundaryResult.ok) throw new Error('bad test space')
const NERV_BOUNDARY = boundaryResult.value

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

describe('read paths after a takedown label', () => {
  let dataDir: string
  let db: ServiceDb
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let labelStore: SqliteLabelStore
  let moderator: Secp256k1Keypair
  let moderatorToken: string
  let ctx: AppContext
  let httpServer: http.Server
  let baseUrl: string
  let methods: Map<string, { handler: Handler }>
  let soloBlobCid: string
  let sharedBlobCid: string
  const blobBytes = new Map<string, string>()

  function uriOf(rkey: string): string {
    return `at://${AUTHOR_DID}/${POST_COLLECTION}/${rkey}`
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-read-paths-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    labelStore = new SqliteLabelStore(db, join(dataDir, 'service.sqlite'))
    enrollmentStore = new SqliteEnrollmentStore(db)
    const blobstore = createMockBlobStore()
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => blobstore,
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })

    moderator = await Secp256k1Keypair.create({ exportable: true })
    const signingKey = await Secp256k1Keypair.create()
    const documents = new Map([[moderator.did(), didDocumentFor(moderator)]])
    const idResolver = {
      did: { resolve: async (did: string) => documents.get(did) },
    } as unknown as IdResolver

    const cfg = createTestConfig(dataDir)
    cfg.moderationServiceDids = [moderator.did()]
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const verifiers = createAuthVerifiers(
      cfg.service.did,
      idResolver,
      cfg,
      { getEnrollment: async () => ({ active: true }) } as never,
      new SqliteAdminSessionStore(db),
      new SqliteAdminUserStore(db),
      [],
      {} as never,
      undefined,
      true,
      signingKey,
      undefined,
      logger,
    )
    const boundaryResolver = new EnrollmentBoundaryResolver(enrollmentStore)
    ctx = {
      cfg,
      serviceDid: SERVICE_DID,
      actorStore,
      enrollmentStore,
      labelStore,
      boundaryResolver,
      blobAuth: new BlobAuthServiceImpl(actorStore, boundaryResolver, logger),
      hydrationService: new HydrationServiceImpl(
        new ActorStoreRecordResolver(actorStore),
        boundaryResolver,
        logger,
      ),
      repoWriteLocks: new RepoWriteLocks(),
      logger,
      authVerifier: verifiers,
    } as unknown as AppContext

    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, ctx)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
    moderatorToken = await createServiceJwt({
      iss: moderator.did(),
      aud: SERVICE_DID,
      lxm: CREATE_LABEL_NSID,
      keypair: moderator,
    })

    methods = new Map()
    const capture = {
      method: (name: string, config: { handler: Handler }) =>
        methods.set(name, config),
    }
    registerSpaceReadHandlers(capture as never, ctx)
    registerHydrationHandlers(capture as never, ctx)

    await enrollmentStore.enroll({
      did: MEMBER_DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
    })
    await enrollmentStore.setBoundaries(MEMBER_DID, [NERV_BOUNDARY])

    await actorStore.create(AUTHOR_DID)
    soloBlobCid = await seedBlob(blobstore, 'entry plug schematics')
    sharedBlobCid = await seedBlob(blobstore, 'magi system diagram')
    await seedPost(FIRST_RKEY, [soloBlobCid, sharedBlobCid])
    await seedPost(SECOND_RKEY, [sharedBlobCid])
  })

  afterEach(async () => {
    ctx.repoWriteLocks.destroy()
    await new Promise((resolve) => httpServer.close(resolve))
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
    blobBytes.clear()
  })

  async function seedBlob(
    blobstore: ReturnType<typeof createMockBlobStore>,
    content: string,
  ): Promise<string> {
    const bytes = new TextEncoder().encode(content)
    const cid = parseCid((await computeCid({ seed: content })).toString())
    await blobstore.putPermanent(cid, bytes)
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.blob.trackBlob({
        cid,
        mimeType: 'image/png',
        size: bytes.length,
      })
    })
    blobBytes.set(cid.toString(), content)
    return cid.toString()
  }

  async function seedPost(rkey: string, blobCids: string[]) {
    const body = {
      $type: POST_COLLECTION,
      text: `Sync ratio report ${rkey}`,
      boundary: {
        $type: DOMAINS_TYPE,
        values: [{ value: NERV_BOUNDARY }],
      },
    }
    const cid = parseCid((await computeCid(body)).toString())
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.record.putRecord({
        uri: uriOf(rkey),
        cid,
        value: body,
        content: encodeRecord(body),
      })
      for (const blobCid of blobCids) {
        await store.blob.associateBlobWithRecord(parseCid(blobCid), uriOf(rkey))
      }
    })
  }

  function createLabel(
    rkey: string,
    extra: Record<string, unknown> = {},
  ): Promise<AxiosResponse> {
    return axios.post(
      `${baseUrl}/xrpc/${CREATE_LABEL_NSID}`,
      {
        subject: { $type: RECORD_SUBJECT_TYPE, uri: uriOf(rkey) },
        val: '!takedown',
        ...extra,
      },
      {
        headers: { authorization: `Bearer ${moderatorToken}` },
        validateStatus: () => true,
      },
    )
  }

  async function takeDown(rkey: string) {
    const res = await createLabel(rkey, { ref: `case-${rkey}` })
    expect(res.status).toBe(200)
    expect(res.data.label.neg).toBe(false)
  }

  async function negate(rkey: string) {
    const res = await createLabel(rkey, { neg: true })
    expect(res.status).toBe(200)
    expect(res.data.label.neg).toBe(true)
  }

  function callHandler(
    handler: Handler,
    args: Record<string, unknown>,
  ): Promise<HandlerResult> {
    return handler({ input: undefined, req: {}, res: {}, ...args })
  }

  async function getRecord(rkey: string) {
    return callHandler(getRecordHandler(ctx) as unknown as Handler, {
      params: { repo: AUTHOR_DID, collection: POST_COLLECTION, rkey },
      auth: MEMBER_AUTH,
    })
  }

  async function listRecords() {
    const result = await callHandler(
      listRecordsHandler(ctx) as unknown as Handler,
      {
        params: { repo: AUTHOR_DID, collection: POST_COLLECTION },
        auth: MEMBER_AUTH,
      },
    )
    return (result.body as ListedBody).records.map((record) => record.uri)
  }

  function getSpaceRecord(rkey: string) {
    return callHandler(methods.get('zone.stratos.space.getRecord')!.handler, {
      params: {
        space: SPACE_URI,
        repo: AUTHOR_DID,
        collection: POST_COLLECTION,
        rkey,
      },
      auth: MEMBER_AUTH,
    })
  }

  async function hydrate(...rkeys: string[]) {
    const result = await callHandler(
      methods.get('zone.stratos.repo.hydrateRecords')!.handler,
      {
        input: { body: { uris: rkeys.map(uriOf) } },
        params: {},
        auth: MEMBER_AUTH,
      },
    )
    return result.body as {
      records: Array<{ uri: string; cid: string; value: { text: string } }>
      notFound: string[]
      blocked: string[]
    }
  }

  async function recordPaths() {
    const result = await listRecordPaths(
      ctx as never,
      {
        did: AUTHOR_DID,
        collection: POST_COLLECTION,
        limit: 50,
        excludeValues: false,
      },
      new Set([NERV_BOUNDARY]),
    )
    return result.records.map((record) => record.rkey)
  }

  function getBlob(blobCid: string) {
    return callHandler(getBlobHandler(ctx) as unknown as Handler, {
      params: { did: AUTHOR_DID, cid: blobCid },
      auth: MEMBER_AUTH,
    })
  }

  async function expectBlobServed(blobCid: string) {
    const served = await getBlob(blobCid)
    expect(served.encoding).toBe('image/png')
    expect(new TextDecoder().decode(served.body as Uint8Array)).toBe(
      blobBytes.get(blobCid),
    )
  }

  async function expectBlobRefused(blobCid: string) {
    await expect(getBlob(blobCid)).rejects.toMatchObject({
      customErrorName: 'BlobBlocked',
    })
  }

  const readPaths: Array<{
    name: string
    expectServed: () => Promise<void>
    expectRefused: () => Promise<void>
  }> = [
    {
      name: 'com.atproto.repo.getRecord',
      expectServed: async () => {
        const served = await getRecord(FIRST_RKEY)
        expect(served.body).toMatchObject({
          uri: uriOf(FIRST_RKEY),
          value: { text: `Sync ratio report ${FIRST_RKEY}` },
        })
      },
      expectRefused: async () => {
        await expect(getRecord(FIRST_RKEY)).rejects.toMatchObject({
          message: 'Record not found',
          customErrorName: 'RecordNotFound',
        })
      },
    },
    {
      name: 'com.atproto.repo.listRecords',
      expectServed: async () => {
        expect(await listRecords()).toEqual(
          expect.arrayContaining([uriOf(FIRST_RKEY), uriOf(SECOND_RKEY)]),
        )
      },
      expectRefused: async () => {
        expect(await listRecords()).toEqual([uriOf(SECOND_RKEY)])
      },
    },
    {
      name: 'zone.stratos.space.getRecord',
      expectServed: async () => {
        const served = await getSpaceRecord(FIRST_RKEY)
        expect(served.body).toMatchObject({
          uri: uriOf(FIRST_RKEY),
          value: { text: `Sync ratio report ${FIRST_RKEY}` },
        })
      },
      expectRefused: async () => {
        await expect(getSpaceRecord(FIRST_RKEY)).rejects.toMatchObject({
          message: 'Record not found',
          customErrorName: 'RecordNotFound',
        })
      },
    },
    {
      name: 'zone.stratos.repo.hydrateRecords',
      expectServed: async () => {
        const hydrated = await hydrate(FIRST_RKEY)
        expect(hydrated.notFound).toEqual([])
        expect(hydrated.blocked).toEqual([])
        expect(hydrated.records).toHaveLength(1)
        expect(hydrated.records[0]).toMatchObject({
          uri: uriOf(FIRST_RKEY),
          value: { text: `Sync ratio report ${FIRST_RKEY}` },
        })
      },
      expectRefused: async () => {
        expect(await hydrate(FIRST_RKEY)).toEqual({
          records: [],
          notFound: [uriOf(FIRST_RKEY)],
          blocked: [],
        })
      },
    },
    {
      name: 'zone.stratos.sync.listRecordPaths',
      expectServed: async () => {
        expect(await recordPaths()).toEqual([FIRST_RKEY, SECOND_RKEY])
      },
      expectRefused: async () => {
        expect(await recordPaths()).toEqual([SECOND_RKEY])
      },
    },
    {
      name: 'zone.stratos.sync.getBlob',
      expectServed: () => expectBlobServed(soloBlobCid),
      expectRefused: () => expectBlobRefused(soloBlobCid),
    },
  ]

  describe.each(readPaths)('$name', ({ expectServed, expectRefused }) => {
    it('serves the record, refuses it after a takedown label, serves it again after the negation', async () => {
      await expectServed()

      await takeDown(FIRST_RKEY)
      await expectRefused()

      await negate(FIRST_RKEY)
      await expectServed()
    })
  })

  describe('blobs of a taken-down record', () => {
    async function blobMarker(blobCid: string) {
      return actorStore.read(AUTHOR_DID, (store) =>
        store.blob.getBlobTakedownStatus(parseCid(blobCid)),
      )
    }

    it('a record label writes no marker on the blobs the record references', async () => {
      await takeDown(FIRST_RKEY)

      expect(await blobMarker(soloBlobCid)).toEqual({ applied: false })
      expect(await blobMarker(sharedBlobCid)).toEqual({ applied: false })
    })

    it('refuses a blob whose only referencing record is taken down', async () => {
      await expectBlobServed(soloBlobCid)

      await takeDown(FIRST_RKEY)

      await expectBlobRefused(soloBlobCid)
    })

    it('still serves a blob that another live record references', async () => {
      await takeDown(FIRST_RKEY)

      await expectBlobServed(sharedBlobCid)
    })

    it('refuses the shared blob once every referencing record is taken down, and serves it after one negation', async () => {
      await takeDown(FIRST_RKEY)
      await takeDown(SECOND_RKEY)

      await expectBlobRefused(sharedBlobCid)
      expect(await blobMarker(sharedBlobCid)).toEqual({ applied: false })

      await negate(SECOND_RKEY)

      await expectBlobServed(sharedBlobCid)
    })
  })

  describe('batch blob access through BlobAuthServiceImpl.canAccessBlobs', () => {
    async function batchAccess(...blobCids: string[]) {
      const access = await ctx.blobAuth.canAccessBlobs(
        MEMBER_DID,
        AUTHOR_DID,
        blobCids.map((blobCid) => parseCid(blobCid)),
      )
      return Object.fromEntries(access)
    }

    it('refuses a blob whose only referencing record is taken down, and serves it again after the negation', async () => {
      expect(await batchAccess(soloBlobCid)).toEqual({ [soloBlobCid]: true })

      await takeDown(FIRST_RKEY)
      expect(await batchAccess(soloBlobCid)).toEqual({ [soloBlobCid]: false })

      await negate(FIRST_RKEY)
      expect(await batchAccess(soloBlobCid)).toEqual({ [soloBlobCid]: true })
    })

    it('serves a shared blob while another referencing record is live, in the same batch as a refused blob', async () => {
      await takeDown(FIRST_RKEY)

      expect(await batchAccess(soloBlobCid, sharedBlobCid)).toEqual({
        [soloBlobCid]: false,
        [sharedBlobCid]: true,
      })
    })

    it('refuses the shared blob once every referencing record is taken down, and serves it after one negation', async () => {
      await takeDown(FIRST_RKEY)
      await takeDown(SECOND_RKEY)
      expect(await batchAccess(sharedBlobCid)).toEqual({
        [sharedBlobCid]: false,
      })

      await negate(SECOND_RKEY)
      expect(await batchAccess(sharedBlobCid)).toEqual({
        [sharedBlobCid]: true,
      })
    })
  })

  describe('zone.stratos.repo.hydrateRecord', () => {
    async function hydrateOne(rkey: string) {
      return callHandler(
        methods.get('zone.stratos.repo.hydrateRecord')!.handler,
        {
          params: { uri: uriOf(rkey) },
          auth: MEMBER_AUTH,
        },
      )
    }

    it('serves the record, refuses it after a takedown label, serves it again after the negation', async () => {
      const served = await hydrateOne(FIRST_RKEY)
      expect(served.body).toMatchObject({
        uri: uriOf(FIRST_RKEY),
        value: { text: `Sync ratio report ${FIRST_RKEY}` },
      })

      await takeDown(FIRST_RKEY)
      await expect(hydrateOne(FIRST_RKEY)).rejects.toMatchObject({
        message: 'Record not found',
        customErrorName: 'RecordNotFound',
      })
      expect((await hydrateOne(SECOND_RKEY)).body).toMatchObject({
        uri: uriOf(SECOND_RKEY),
      })

      await negate(FIRST_RKEY)
      expect((await hydrateOne(FIRST_RKEY)).body).toMatchObject({
        uri: uriOf(FIRST_RKEY),
        value: { text: `Sync ratio report ${FIRST_RKEY}` },
      })
    })
  })
})
