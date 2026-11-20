import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import axios, { type AxiosResponse } from 'axios'
import express from 'express'
import { decode } from '@atcute/cbor'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  RECORD_SUBJECT_TYPE,
  stratosLexicons,
} from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import { EnrollmentBoundaryResolver } from '../src/features/enrollment/index.js'
import type { AppContext } from '../src/context.js'
import {
  applyWritesBatch,
  createRecord,
  deleteRecord,
} from '../src/api/records/index.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db/index.js'
import {
  registerModerationHandlers,
  SqliteLabelStore,
} from '../src/features/moderation/index.js'
import { listRepoOps } from '../src/features/pull-sync/index.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { SqliteAdminSessionStore } from '../src/oauth/admin-session-store.js'
import { SqliteAdminUserStore } from '../src/oauth/admin-user-store.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
import { createSubscribeRecordsHandler } from '../src/subscription/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:stratos.test'
const NERV_SERVICE_DID = 'did:web:nerv.tokyo.jp'
const SEELE_SERVICE_DID = 'did:web:seele.de'
const AUTHOR_DID = 'did:plc:rei-ayanami'
const ADMIN_DID = 'did:plc:gendo-ikari'
const POST = 'zone.stratos.feed.post'
const NERV_NAME = 'nerv'
const NERV = `${SERVICE_DID}/${NERV_NAME}`
const SEELE = `${SERVICE_DID}/seele`
const IDLE_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

const uriOf = (rkey: string) => `at://${AUTHOR_DID}/${POST}/${rkey}`

function postBody(rkey: string) {
  return {
    $type: POST,
    text: `Angel sighting ${rkey}`,
    createdAt: '1996-10-04T00:00:00.000Z',
    boundary: { values: [{ value: NERV }] },
  }
}

const serviceCredsFor = (did: string) => ({
  credentials: { type: 'service', iss: did, did },
})

describe('deleting a taken-down record', () => {
  let dataDir: string
  let db: ServiceDb
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let sequenceEvents: EventEmitter
  let repoWriteLocks: RepoWriteLocks
  let labelStore: SqliteLabelStore
  let ctx: AppContext
  let moderator: Secp256k1Keypair
  let httpServer: http.Server
  let moderatorToken: string
  let baseUrl: string

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-delete-takedown-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })
    sequenceEvents = new EventEmitter()
    repoWriteLocks = new RepoWriteLocks()
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }
    const cfg = createTestConfig(dataDir)
    cfg.stratos.serviceDid = SERVICE_DID
    cfg.stratos.allowedDomains = [NERV_NAME]
    labelStore = new SqliteLabelStore(db, join(dataDir, 'service.sqlite'))
    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      boundaryResolver: new EnrollmentBoundaryResolver(enrollmentStore),
      labelStore,
      serviceDid: SERVICE_DID,
      sequenceEvents,
      enrollmentEvents: new EventEmitter(),
      writeRateLimiter: { assertWriteAllowed: vi.fn() },
      actorSigner: {
        getSignFn: vi
          .fn()
          .mockResolvedValue(() => Promise.resolve(new Uint8Array(64))),
      },
      repoWriteLocks,
      logger,
    } as unknown as AppContext

    await enrollmentStore.enroll({
      did: AUTHOR_DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: AUTHOR_DID,
    })
    await enrollmentStore.setBoundaries(AUTHOR_DID, [NERV])
    for (const [did, boundary] of [
      [NERV_SERVICE_DID, NERV],
      [SEELE_SERVICE_DID, SEELE],
    ]) {
      await enrollmentStore.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: did,
        isService: true,
      })
      await enrollmentStore.setBoundaries(did, [boundary])
    }
    await actorStore.create(AUTHOR_DID)

    moderator = await Secp256k1Keypair.create({ exportable: true })
    const signingKey = await Secp256k1Keypair.create()
    const documents = new Map([[moderator.did(), didDocumentFor(moderator)]])
    const idResolver = {
      did: { resolve: async (did: string) => documents.get(did) },
    } as unknown as IdResolver
    const moderationCfg = createTestConfig(dataDir)
    moderationCfg.moderationServiceDids = [moderator.did()]
    const verifiers = createAuthVerifiers(
      moderationCfg.service.did,
      idResolver,
      moderationCfg,
      enrollmentStore,
      new SqliteAdminSessionStore(db),
      new SqliteAdminUserStore(db),
      [ADMIN_DID],
      {} as never,
      undefined,
      true,
      signingKey,
      undefined,
      logger,
    )
    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, {
      cfg: moderationCfg,
      serviceDid: SERVICE_DID,
      actorStore,
      labelStore,
      repoWriteLocks,
      logger,
      authVerifier: verifiers,
    } as never)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
    moderatorToken = await createServiceJwt({
      iss: moderator.did(),
      aud: SERVICE_DID,
      lxm: 'zone.stratos.moderation.createLabel',
      keypair: moderator,
    })
  })

  afterEach(async () => {
    repoWriteLocks.destroy()
    await new Promise((resolve) => httpServer.close(resolve))
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  async function createPost(rkey: string) {
    return createRecord(
      ctx,
      {
        repo: AUTHOR_DID,
        collection: POST,
        rkey,
        record: postBody(rkey),
      },
      AUTHOR_DID,
    )
  }

  function takedownLabel(rkey: string): Promise<AxiosResponse> {
    return axios.post(
      `${baseUrl}/xrpc/zone.stratos.moderation.createLabel`,
      {
        subject: { $type: RECORD_SUBJECT_TYPE, uri: uriOf(rkey) },
        val: '!takedown',
      },
      {
        headers: { authorization: `Bearer ${moderatorToken}` },
        validateStatus: () => true,
      },
    )
  }

  async function takeDown(rkey: string) {
    const res = await takedownLabel(rkey)
    expect(res.status).toBe(200)
  }

  const removePost = (rkey: string, swapRecord?: string) =>
    deleteRecord(
      ctx,
      { repo: AUTHOR_DID, collection: POST, rkey, swapRecord },
      AUTHOR_DID,
    )

  interface DecodedOp {
    action: string
    path: string
    boundary?: { values: Array<{ value: string }> }
  }

  const opsOf = (event: DecodedOp & { ops?: DecodedOp[] }) =>
    event.ops ?? [event]

  /** Events holding a delete op that names its boundary, in sequence order. A single-op event is flat; a batch event nests `ops`. */
  async function boundaryDeleteEvents() {
    const events = await actorStore.read(AUTHOR_DID, (store) =>
      store.sequence.getEventsSince(0, 100),
    )
    return events
      .map((event) => ({
        seq: event.seq,
        ops: opsOf(decode(event.event) as DecodedOp & { ops?: DecodedOp[] }),
      }))
      .filter((event) =>
        event.ops.some((op) => op.action === 'delete' && op.boundary),
      )
  }

  const latestSeq = () =>
    actorStore.read(AUTHOR_DID, async (store) =>
      Number(await store.sequence.getLatestSeq()),
    )

  async function recordRow(rkey: string) {
    return actorStore.read(AUTHOR_DID, (store) =>
      store.record.getRecord(uriOf(rkey), null, true),
    )
  }

  function subscribe(subscriberDid: string, cursor: number) {
    const abortController = new AbortController()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = createSubscribeRecordsHandler(ctx) as any
    const generator = handler(
      { did: AUTHOR_DID, cursor },
      serviceCredsFor(subscriberDid),
      abortController.signal,
    ) as AsyncGenerator<
      {
        seq: number
        ops: Array<{
          action: string
          path: string
          record?: unknown
          boundary?: { values: Array<{ value: string }> }
        }>
      },
      void
    >
    return { generator, abortController }
  }

  /** Resolves once the stream has registered its wake listener. */
  function parkedOnWake(): Promise<void> {
    return new Promise((resolve) =>
      sequenceEvents.once('newListener', (event) => {
        if (event === AUTHOR_DID) resolve()
      }),
    )
  }

  /** A live subscriber, parked and waiting for the next frame. */
  async function parkedSubscriber(subscriberDid: string) {
    const { generator, abortController } = subscribe(
      subscriberDid,
      await latestSeq(),
    )
    const parked = parkedOnWake()
    const pending = generator.next()
    await parked
    return { generator, pending, abortController }
  }

  /** Wake the stream until it delivers, so a late listener is never missed. */
  async function frameAfterWake<T>(pending: Promise<T>): Promise<T> {
    const wake = setInterval(() => sequenceEvents.emit(AUTHOR_DID), 5)
    try {
      return await pending
    } finally {
      clearInterval(wake)
    }
  }

  async function expectNoFrame(pending: Promise<unknown>): Promise<void> {
    const wake = setInterval(() => sequenceEvents.emit(AUTHOR_DID), 5)
    try {
      const outcome = await Promise.race([
        pending.then(() => 'frame' as const),
        sleep(IDLE_MS).then(() => 'idle' as const),
      ])
      expect(outcome).toBe('idle')
    } finally {
      clearInterval(wake)
    }
  }

  const callerSet = (...boundaries: string[]) => new Set(boundaries)

  const listOps = (boundaries: ReadonlySet<string>) =>
    listRepoOps(
      ctx,
      { did: AUTHOR_DID, limit: 100, excludeValues: false },
      boundaries,
    )

  it('(d1) sequences one delete event with the boundaries and delivers it live to a subscriber in scope only', async () => {
    await createPost('ayanami')
    await takeDown('ayanami')
    const seqBeforeDelete = await latestSeq()
    const inScope = await parkedSubscriber(NERV_SERVICE_DID)
    const outOfScope = await parkedSubscriber(SEELE_SERVICE_DID)

    await removePost('ayanami')

    const deleteEvents = await boundaryDeleteEvents()
    expect(deleteEvents).toHaveLength(1)
    expect(deleteEvents[0].seq).toBeGreaterThan(seqBeforeDelete)
    expect(deleteEvents[0].ops).toEqual([
      expect.objectContaining({
        action: 'delete',
        path: `${POST}/ayanami`,
        boundary: { values: [{ value: NERV }] },
      }),
    ])

    const frame = await frameAfterWake(inScope.pending)
    inScope.abortController.abort()
    expect(frame.done).toBe(false)
    expect(frame.value?.seq).toBe(deleteEvents[0].seq)
    expect(frame.value?.ops).toEqual([
      expect.objectContaining({ action: 'delete', path: `${POST}/ayanami` }),
    ])

    await expectNoFrame(outOfScope.pending)
    outOfScope.abortController.abort()
  })

  it('(d2) listRepoOps from scratch returns a delete for the record and no create or update', async () => {
    await createPost('ayanami')
    await createPost('soryu')
    await takeDown('ayanami')
    await removePost('ayanami')

    const res = await listOps(callerSet(NERV))

    const opsForDeleted = res.ops.filter((op) => op.rkey === 'ayanami')
    expect(opsForDeleted).toEqual([
      expect.objectContaining({
        collection: POST,
        rkey: 'ayanami',
        cid: null,
      }),
    ])
    expect(res.ops.filter((op) => op.rkey === 'soryu')).toEqual([
      expect.objectContaining({ cid: expect.any(String) }),
    ])
    expect((await listOps(callerSet(SEELE))).ops).toEqual([])
  })

  describe('(d3) swapRecord', () => {
    it('deletes a taken-down record when the CID matches', async () => {
      const created = await createPost('ayanami')
      await takeDown('ayanami')

      await expect(removePost('ayanami', created.cid)).resolves.toMatchObject({
        commit: expect.anything(),
      })

      expect(await recordRow('ayanami')).toBeNull()
    })

    it('still rejects a wrong CID with InvalidSwap and sequences nothing', async () => {
      const other = await createPost('soryu')
      await createPost('ayanami')
      await takeDown('ayanami')
      const seqBefore = await latestSeq()

      await expect(removePost('ayanami', other.cid)).rejects.toMatchObject({
        error: 'InvalidSwap',
      })

      expect(await recordRow('ayanami')).not.toBeNull()
      expect(await latestSeq()).toBe(seqBefore)
    })
  })

  it('(d4) deleting a record that was never taken down sequences the same delete event', async () => {
    await createPost('ayanami')
    const seqBeforeDelete = await latestSeq()
    const inScope = await parkedSubscriber(NERV_SERVICE_DID)

    await removePost('ayanami')

    const deleteEvents = await boundaryDeleteEvents()
    expect(deleteEvents).toHaveLength(1)
    expect(deleteEvents[0].seq).toBeGreaterThan(seqBeforeDelete)
    expect(deleteEvents[0].ops).toEqual([
      expect.objectContaining({
        action: 'delete',
        path: `${POST}/ayanami`,
        boundary: { values: [{ value: NERV }] },
      }),
    ])
    const frame = await frameAfterWake(inScope.pending)
    inScope.abortController.abort()
    expect(frame.value?.ops).toEqual([
      expect.objectContaining({ action: 'delete', path: `${POST}/ayanami` }),
    ])
    expect(
      (await listOps(callerSet(NERV))).ops.map((op) => [op.rkey, op.cid]),
    ).toEqual([['ayanami', null]])
  })

  interface ReplayFrame {
    seq: number
    ops: Array<{ action: string; path: string; record?: unknown }>
  }

  /** Replays the whole sequence log from the start, then closes the stream. */
  async function replayFromStart(): Promise<ReplayFrame[]> {
    const { generator, abortController } = subscribe(NERV_SERVICE_DID, 0)
    const frames: ReplayFrame[] = []
    for (;;) {
      const pending = generator.next()
      const outcome = await Promise.race([
        pending,
        sleep(IDLE_MS).then(() => 'idle' as const),
      ])
      if (outcome === 'idle') {
        abortController.abort()
        await pending
        return frames
      }
      if (outcome.done) return frames
      // Cursor 0 sits before the oldest retained event, so an info frame comes first.
      if (outcome.value.ops) frames.push(outcome.value)
    }
  }

  const replayedOps = async () =>
    (await replayFromStart()).flatMap((frame) => frame.ops)

  const opSummary = (op: { action: string; path: string }) =>
    `${op.action} ${op.path}`

  /** Pages through listRepoOps one op at a time so each event is its own response. */
  async function oplogPages(limit = 1) {
    const pages: Awaited<ReturnType<typeof listOps>>[] = []
    let cursor: string | undefined
    do {
      const page = await listRepoOps(
        ctx,
        { did: AUTHOR_DID, limit, excludeValues: false, cursor },
        callerSet(NERV),
      )
      pages.push(page)
      cursor = page.cursor
    } while (cursor !== undefined && pages.length < 20)
    return pages
  }

  const oplogSummary = async () =>
    (await oplogPages()).flatMap((page) =>
      page.ops.map(
        (op) => `${op.cid === null ? 'delete' : 'write'} ${op.rkey}`,
      ),
    )

  /** The route refuses a negation once the record row is gone, so these tests write it through the store. */
  const negateInLog = (rkey: string) =>
    appendLabelOnStore(uriOf(rkey), 'record', true)

  async function appendLabelOnStore(
    subjectKey: string,
    subjectKind: 'record' | 'account',
    neg: boolean,
  ) {
    const latest = await labelStore.latestForSubject(subjectKey)
    const result = await labelStore.appendIfLatest(latest?.seq ?? null, {
      subjectKey,
      subjectKind,
      val: '!takedown',
      neg,
      boundaries: subjectKind === 'record' ? [NERV] : [],
      createdBy: 'did:plc:gendo-ikari',
      createdAt: new Date().toISOString(),
    })
    expect(result.kind).toBe('appended')
  }

  describe('(e) sync replay after a taken-down record is deleted', () => {
    async function takeDownAndDelete(rkey: string) {
      await createPost(rkey)
      await takeDown(rkey)
      await removePost(rkey)
    }

    it('(e1) subscribeRecords replays the delete but not the old create or its value', async () => {
      await createPost('soryu')
      await takeDownAndDelete('ayanami')

      const ops = await replayedOps()

      expect(ops.map(opSummary)).toEqual([
        `create ${POST}/soryu`,
        `delete ${POST}/ayanami`,
      ])
      expect(JSON.stringify(ops)).not.toContain('Angel sighting ayanami')
    })

    it('(e1b) the same holds when a batch deleted the record', async () => {
      await createPost('ayanami')
      await takeDown('ayanami')
      await applyWritesBatch(ctx, AUTHOR_DID, [
        { action: 'delete', collection: POST, rkey: 'ayanami' },
      ])

      const ops = await replayedOps()

      expect(ops.map(opSummary)).toEqual([`delete ${POST}/ayanami`])
      expect(await oplogSummary()).toEqual(['delete ayanami'])
    })

    it('(e2) listRepoOps never carries the old create, even when create and delete fall in different responses', async () => {
      await createPost('ayanami')
      await createPost('soryu')
      await takeDown('ayanami')
      await removePost('ayanami')

      const pages = await oplogPages()

      expect(pages.length).toBeGreaterThan(1)
      const deletePage = pages.findIndex((page) =>
        page.ops.some((op) => op.rkey === 'ayanami' && op.cid === null),
      )
      expect(deletePage).toBeGreaterThan(0)
      expect(JSON.stringify(pages)).not.toContain('Angel sighting ayanami')
      expect(
        pages
          .flatMap((page) => page.ops)
          .map((op) => [op.rkey, op.cid === null]),
      ).toEqual([
        ['soryu', false],
        ['ayanami', true],
      ])
    })

    it('(e3) a negation in the label log serves the old create again on both paths', async () => {
      await takeDownAndDelete('ayanami')
      expect(await replayedOps()).toHaveLength(1)

      await negateInLog('ayanami')

      expect((await replayedOps()).map(opSummary)).toEqual([
        `create ${POST}/ayanami`,
        `delete ${POST}/ayanami`,
      ])
      expect(await oplogSummary()).toEqual(['write ayanami', 'delete ayanami'])
    })

    it('(e4) a deleted record that was never labelled replays its create and its delete', async () => {
      await createPost('ayanami')
      await removePost('ayanami')

      expect((await replayedOps()).map(opSummary)).toEqual([
        `create ${POST}/ayanami`,
        `delete ${POST}/ayanami`,
      ])
      expect(await oplogSummary()).toEqual(['write ayanami', 'delete ayanami'])
    })

    it('(e5) a record re-created at the same URI is served with its old create', async () => {
      await takeDownAndDelete('ayanami')
      await createPost('ayanami')

      expect((await replayedOps()).map(opSummary)).toEqual([
        `create ${POST}/ayanami`,
        `delete ${POST}/ayanami`,
        `create ${POST}/ayanami`,
      ])
      expect(await oplogSummary()).toEqual([
        'write ayanami',
        'delete ayanami',
        'write ayanami',
      ])
    })

    it('(e6) account labels and space-form labels never hide a repo-form record', async () => {
      await createPost('ayanami')
      await removePost('ayanami')
      await appendLabelOnStore(AUTHOR_DID, 'account', false)
      await appendLabelOnStore(
        `at:space/${SERVICE_DID}/zone.stratos.space.feed/${NERV_NAME}/${AUTHOR_DID}/${POST}/ayanami`,
        'record',
        false,
      )

      expect((await replayedOps()).map(opSummary)).toEqual([
        `create ${POST}/ayanami`,
        `delete ${POST}/ayanami`,
      ])
      expect(await oplogSummary()).toEqual(['write ayanami', 'delete ayanami'])
    })
  })

  describe('batch delete of a taken-down record', () => {
    const batchDeleteAndCreate = (deleteRkey: string, createRkey: string) =>
      applyWritesBatch(ctx, AUTHOR_DID, [
        { action: 'delete', collection: POST, rkey: deleteRkey },
        {
          action: 'create',
          collection: POST,
          rkey: createRkey,
          record: postBody(createRkey),
        },
      ])

    it('(b1) succeeds, sequences the delete with its boundary and delivers it live next to the create', async () => {
      await createPost('ayanami')
      await takeDown('ayanami')
      const seqBeforeBatch = await latestSeq()
      const inScope = await parkedSubscriber(NERV_SERVICE_DID)

      await expect(
        batchDeleteAndCreate('ayanami', 'katsuragi'),
      ).resolves.toMatchObject({ commit: expect.anything() })

      const deleteEvents = await boundaryDeleteEvents()
      expect(deleteEvents).toHaveLength(1)
      expect(deleteEvents[0].seq).toBeGreaterThan(seqBeforeBatch)
      expect(deleteEvents[0].ops).toEqual([
        expect.objectContaining({
          action: 'delete',
          path: `${POST}/ayanami`,
          boundary: { values: [{ value: NERV }] },
        }),
      ])
      expect(await recordRow('ayanami')).toBeNull()

      const deleteFrame = await frameAfterWake(inScope.pending)
      const createFrame = await frameAfterWake(inScope.generator.next())
      inScope.abortController.abort()
      expect(deleteFrame.value?.ops).toEqual([
        expect.objectContaining({
          action: 'delete',
          path: `${POST}/ayanami`,
        }),
      ])
      expect(createFrame.value?.ops).toEqual([
        expect.objectContaining({
          action: 'create',
          path: `${POST}/katsuragi`,
        }),
      ])

      const delivered = await listOps(callerSet(NERV))
      expect(delivered.ops.map((op) => [op.rkey, op.cid === null])).toEqual(
        expect.arrayContaining([
          ['ayanami', true],
          ['katsuragi', false],
        ]),
      )
    })

    it('(b2) listRepoOps from scratch returns a delete for the record and no create or update', async () => {
      await createPost('ayanami')
      await takeDown('ayanami')
      await batchDeleteAndCreate('ayanami', 'katsuragi')

      const res = await listOps(callerSet(NERV))

      expect(res.ops.filter((op) => op.rkey === 'ayanami')).toEqual([
        expect.objectContaining({
          collection: POST,
          rkey: 'ayanami',
          cid: null,
        }),
      ])
      expect(res.ops.filter((op) => op.rkey === 'katsuragi')).toEqual([
        expect.objectContaining({ cid: expect.any(String) }),
      ])
      expect((await listOps(callerSet(SEELE))).ops).toEqual([])
    })

    it('(b3) still fails with RecordNotFound for a record that does not exist and sequences nothing', async () => {
      await createPost('ayanami')
      const seqBefore = await latestSeq()

      await expect(
        batchDeleteAndCreate('misato', 'katsuragi'),
      ).rejects.toMatchObject({ error: 'RecordNotFound' })

      expect(await latestSeq()).toBe(seqBefore)
      expect(await recordRow('katsuragi')).toBeNull()
    })
  })
})
