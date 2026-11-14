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
  computeCid,
  encodeRecord,
  parseCid,
  RECORD_SUBJECT_TYPE,
  stratosLexicons,
} from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import { createRecord } from '../src/api/records/index.js'
import { EnrollmentBoundaryResolver } from '../src/features/enrollment/index.js'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'
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
import { serviceMetrics } from '../src/observability/metrics.js'
import { createSubscribeRecordsHandler } from '../src/subscription/index.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'

const SERVICE_DID = 'did:web:stratos.test'
const SUBSCRIBER_DID = 'did:web:nerv.tokyo.jp'
const AUTHOR_DID = 'did:plc:rei-ayanami'
const ADMIN_DID = 'did:plc:gendo-ikari'
const POST = 'zone.stratos.feed.post'
const SHARED_BOUNDARY_NAME = 'nerv'
const SHARED_BOUNDARY = `${SERVICE_DID}/${SHARED_BOUNDARY_NAME}`
const OTHER_BOUNDARY = `${SERVICE_DID}/seele`
const PAGE_SIZE = 100
const IDLE_MS = 100

const serviceCreds = {
  credentials: { type: 'service', iss: SUBSCRIBER_DID, did: SUBSCRIBER_DID },
}

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

function postBody(rkey: string, boundary = SHARED_BOUNDARY) {
  return {
    $type: POST,
    text: `Angel sighting ${rkey}`,
    boundary: { values: [{ value: boundary }] },
  }
}

describe('subscribeRecords takedown filter', () => {
  let dataDir: string
  let db: ServiceDb
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let sequenceEvents: EventEmitter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx: any
  let revCounter: number

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-sub-takedown-${randomBytes(8).toString('hex')}`,
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
    revCounter = 0
    const cfg = createTestConfig(dataDir)
    cfg.stratos.serviceDid = SERVICE_DID
    cfg.stratos.allowedDomains = [SHARED_BOUNDARY_NAME]
    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      boundaryResolver: new EnrollmentBoundaryResolver(enrollmentStore),
      serviceDid: SERVICE_DID,
      labelStore: new SqliteLabelStore(db, join(dataDir, 'service.sqlite')),
      sequenceEvents,
      enrollmentEvents: new EventEmitter(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    }

    await enrollmentStore.enroll({
      did: SUBSCRIBER_DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: SUBSCRIBER_DID,
      isService: true,
    })
    await enrollmentStore.setBoundaries(SUBSCRIBER_DID, [SHARED_BOUNDARY])
    await actorStore.create(AUTHOR_DID)
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  async function indexPost(rkey: string, boundary = SHARED_BOUNDARY) {
    const body = postBody(rkey, boundary)
    const cid = parseCid((await computeCid(body)).toString())
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.record.putRecord({
        uri: uriOf(rkey),
        cid,
        value: body,
        content: encodeRecord(body),
      })
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type FixtureOp = Record<string, any>

  async function appendEvent(ops: FixtureOp[]) {
    revCounter++
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.sequence.appendEvent({
        did: AUTHOR_DID,
        eventType: 'append',
        event: Buffer.from(encodeRecord({ rev: `rev${revCounter}`, ops })),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })
  }

  function valueOp(
    action: 'create' | 'update',
    rkey: string,
    boundary = SHARED_BOUNDARY,
  ): FixtureOp {
    return {
      action,
      path: `${POST}/${rkey}`,
      record: postBody(rkey, boundary),
    }
  }

  async function createPost(rkey: string, boundary = SHARED_BOUNDARY) {
    await indexPost(rkey, boundary)
    await appendEvent([valueOp('create', rkey, boundary)])
  }

  async function setTakedown(rkey: string, applied: boolean) {
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.record.updateRecordTakedown(
        uriOf(rkey),
        applied ? { applied, ref: `TD-${rkey}` } : { applied },
      )
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function subscribe(streamCtx: any = ctx, cursor?: number) {
    const abortController = new AbortController()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = createSubscribeRecordsHandler(streamCtx) as any
    const generator = handler(
      { did: AUTHOR_DID, cursor },
      serviceCreds,
      abortController.signal,
    ) as AsyncGenerator<
      {
        seq: number
        rev: string
        ops: Array<{ action: string; path: string; record?: unknown }>
      },
      void
    >
    return { generator, abortController }
  }

  /** Drain a stream until it parks idle, then close it. */
  async function framesUntilIdle(streamCtx: unknown = ctx, cursor?: number) {
    const { generator, abortController } = subscribe(streamCtx, cursor)
    const frames = []
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
      frames.push(outcome.value)
    }
  }

  const framePaths = (frames: Array<{ ops: Array<{ path: string }> }>) =>
    frames.flatMap((frame) => frame.ops.map((op) => op.path))

  /** Resolves once the stream has registered its wake listener. */
  function parkedOnWake(): Promise<void> {
    return new Promise((resolve) =>
      sequenceEvents.once('newListener', (event) => {
        if (event === AUTHOR_DID) resolve()
      }),
    )
  }

  async function expectNoFrame(
    pending: Promise<unknown>,
    ms = IDLE_MS,
  ): Promise<void> {
    const outcome = await Promise.race([
      pending.then(() => 'frame' as const),
      sleep(ms).then(() => 'idle' as const),
    ])
    expect(outcome).toBe('idle')
  }

  /** Wake the stream until it delivers, so a late listener cannot be missed. */
  async function wakeUntilFrame<T>(pending: Promise<T>): Promise<T> {
    const wake = setInterval(() => sequenceEvents.emit(AUTHOR_DID), 5)
    try {
      return await pending
    } finally {
      clearInterval(wake)
    }
  }

  /** Wraps the actor store so lookups on the record reader are observable. */
  function ctxWithTakedownLookup(
    lookup: (
      uris: string[],
      real: (uris: string[]) => Promise<Map<string, boolean>>,
    ) => Promise<Map<string, boolean>>,
  ) {
    return {
      ...ctx,
      actorStore: {
        exists: (did: string) => actorStore.exists(did),
        read: (did: string, fn: (store: unknown) => unknown) =>
          actorStore.read(did, (store) =>
            fn({
              ...store,
              record: {
                getTakedownStates: (uris: string[]) =>
                  lookup(uris, (all) => store.record.getTakedownStates(all)),
              },
            }),
          ),
      },
    }
  }

  function countingLookupCtx() {
    const counter = { lookups: 0 }
    return {
      counter,
      ctx: ctxWithTakedownLookup((uris, real) => {
        counter.lookups++
        return real(uris)
      }),
    }
  }

  async function appendBacklog(count: number, boundary = SHARED_BOUNDARY) {
    await actorStore.transact(AUTHOR_DID, async (store) => {
      for (let index = 1; index <= count; index++) {
        await store.sequence.appendEvent({
          did: AUTHOR_DID,
          eventType: 'append',
          event: Buffer.from(
            encodeRecord({
              rev: `rev${index}`,
              ops: [valueOp('create', `backlog-${index}`, boundary)],
            }),
          ),
          invalidated: 0,
          sequencedAt: new Date().toISOString(),
        })
      }
    })
  }

  it('(s1) a connect from cursor 0 after a takedown never carries the record or a valueless op', async () => {
    await createPost('ayanami')
    await createPost('soryu')
    await setTakedown('ayanami', true)

    const frames = await framesUntilIdle()

    expect(framePaths(frames)).toEqual([`${POST}/soryu`])
    const valueOps = frames
      .flatMap((frame) => frame.ops)
      .filter((op) => op.action !== 'delete')
    expect(valueOps.length).toBeGreaterThan(0)
    for (const op of valueOps) expect(op.record).toBeDefined()
    expect(JSON.stringify(frames)).not.toContain('Angel sighting ayanami')
  })

  it('(s2) a multi-op event delivers one frame holding only the op that is not taken down', async () => {
    await indexPost('ayanami')
    await indexPost('soryu')
    await appendEvent([
      valueOp('create', 'ayanami'),
      valueOp('create', 'soryu'),
    ])
    await setTakedown('ayanami', true)

    const frames = await framesUntilIdle()

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(1)
    expect(frames[0].ops.map((op) => op.path)).toEqual([`${POST}/soryu`])
    expect(frames[0].ops[0].record).toBeDefined()
  })

  it('(s3) an event emptied by the filter is skipped and the next event keeps its own seq', async () => {
    await createPost('ayanami')
    await createPost('soryu')
    await setTakedown('ayanami', true)

    const frames = await framesUntilIdle()

    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(2)
    expect(frames[0].ops).toHaveLength(1)
  })

  it('(s4) after a negation a replay from cursor 0 delivers the record again', async () => {
    await createPost('ayanami')
    await setTakedown('ayanami', true)
    expect(await framesUntilIdle()).toEqual([])

    await setTakedown('ayanami', false)
    const frames = await framesUntilIdle()

    expect(framePaths(frames)).toEqual([`${POST}/ayanami`])
    expect(frames[0].ops[0].record).toBeDefined()
  })

  it('(s6) a live update of a taken-down record sends no frame', async () => {
    await createPost('ayanami')
    await setTakedown('ayanami', true)
    const { generator, abortController } = subscribe()

    const parked = parkedOnWake()
    const pending = generator.next()
    // A leaked backlog frame settles `pending` first; the check below reports it.
    await Promise.race([parked, pending])
    await appendEvent([valueOp('update', 'ayanami')])
    sequenceEvents.emit(AUTHOR_DID)
    await expectNoFrame(pending)

    await indexPost('soryu')
    await appendEvent([valueOp('create', 'soryu')])
    const frame = await wakeUntilFrame(pending)
    abortController.abort()

    expect(frame.done).toBe(false)
    expect(frame.value?.seq).toBe(3)
    expect(framePaths([frame.value!])).toEqual([`${POST}/soryu`])
  })

  describe('(s5) labels never travel on the stream', () => {
    let labelDb: ServiceDb
    let moderator: Secp256k1Keypair
    let httpServer: http.Server
    let labelCtx: { repoWriteLocks: RepoWriteLocks }
    let moderatorToken: string
    let baseUrl: string

    beforeEach(async () => {
      labelDb = createServiceDb(join(dataDir, 'labels.sqlite'))
      await migrateServiceDb(labelDb)
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
        enrollmentStore,
        new SqliteAdminSessionStore(labelDb),
        new SqliteAdminUserStore(labelDb),
        [ADMIN_DID],
        {} as never,
        undefined,
        true,
        signingKey,
        undefined,
        logger,
      )
      labelCtx = { repoWriteLocks: new RepoWriteLocks() }
      const moderationCtx = {
        cfg,
        serviceDid: SERVICE_DID,
        actorStore,
        labelStore: new SqliteLabelStore(
          labelDb,
          join(dataDir, 'labels.sqlite'),
        ),
        repoWriteLocks: labelCtx.repoWriteLocks,
        logger,
        authVerifier: verifiers,
      }
      const server = new XrpcServer(stratosLexicons)
      registerModerationHandlers(server, moderationCtx as never)
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
      labelCtx.repoWriteLocks.destroy()
      await new Promise((resolve) => httpServer.close(resolve))
      await closeServiceDb(labelDb)
    })

    function postLabel(
      rkey: string,
      extra: { neg?: boolean },
    ): Promise<AxiosResponse> {
      return axios.post(
        `${baseUrl}/xrpc/zone.stratos.moderation.createLabel`,
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

    const takedownLabel = (rkey: string) => postLabel(rkey, {})
    const negationLabel = (rkey: string) => postLabel(rkey, { neg: true })

    it('writing a takedown label sends nothing; the next post is the first frame after it', async () => {
      await createPost('ayanami')
      const { ctx: lookupCtx, counter } = countingLookupCtx()
      const { generator, abortController } = subscribe(lookupCtx)
      const first = await generator.next()
      expect(framePaths([first.value!])).toEqual([`${POST}/ayanami`])

      const parked = parkedOnWake()
      const pending = generator.next()
      await parked
      const lookupsBeforeLabel = counter.lookups
      const seqBeforeLabel = await actorStore.read(AUTHOR_DID, (store) =>
        store.sequence.getLatestSeq(),
      )

      const res = await takedownLabel('ayanami')
      expect(res.status).toBe(200)

      await expectNoFrame(pending)
      expect(counter.lookups).toBe(lookupsBeforeLabel)
      expect(
        await actorStore.read(AUTHOR_DID, (store) =>
          store.sequence.getLatestSeq(),
        ),
      ).toBe(seqBeforeLabel)

      await createPost('soryu')
      const next = await wakeUntilFrame(pending)
      abortController.abort()

      expect(next.value?.seq).toBe(seqBeforeLabel + 1)
      expect(framePaths([next.value!])).toEqual([`${POST}/soryu`])
    })

    it('(p1) records written by createRecord leave both sync paths on takedown and return on negation', async () => {
      await enrollmentStore.enroll({
        did: AUTHOR_DID,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: AUTHOR_DID,
      })
      await enrollmentStore.setBoundaries(AUTHOR_DID, [SHARED_BOUNDARY])
      const writeCtx = {
        ...ctx,
        writeRateLimiter: { assertWriteAllowed: vi.fn() },
        actorSigner: {
          getSignFn: vi
            .fn()
            .mockResolvedValue(() => Promise.resolve(new Uint8Array(64))),
        },
        repoWriteLocks: labelCtx.repoWriteLocks,
      }
      for (const rkey of ['ayanami', 'soryu']) {
        await createRecord(
          writeCtx,
          {
            repo: AUTHOR_DID,
            collection: POST,
            rkey,
            record: {
              ...postBody(rkey),
              createdAt: '1996-10-04T00:00:00.000Z',
            },
          },
          AUTHOR_DID,
        )
      }
      const storedEvents = await actorStore.read(AUTHOR_DID, (store) =>
        store.sequence.getEventsSince(0, 100),
      )
      expect(storedEvents).toHaveLength(2)

      const rkeysFromOpLog = async () =>
        (
          await listRepoOps(
            writeCtx,
            { did: AUTHOR_DID, limit: 100, excludeValues: false },
            new Set([SHARED_BOUNDARY]),
          )
        ).ops.map((op) => op.rkey)

      expect((await takedownLabel('ayanami')).status).toBe(200)

      expect(framePaths(await framesUntilIdle(writeCtx))).toEqual([
        `${POST}/soryu`,
      ])
      expect(await rkeysFromOpLog()).toEqual(['soryu'])

      expect((await negationLabel('ayanami')).status).toBe(200)

      expect(framePaths(await framesUntilIdle(writeCtx))).toEqual([
        `${POST}/ayanami`,
        `${POST}/soryu`,
      ])
      expect(await rkeysFromOpLog()).toEqual(['ayanami', 'soryu'])
    })
  })

  describe('(s7) one takedown lookup per page', () => {
    it('a 150-event backlog makes two lookups', async () => {
      await appendBacklog(150)
      const { ctx: lookupCtx, counter } = countingLookupCtx()

      const frames = await framesUntilIdle(lookupCtx)

      expect(frames).toHaveLength(150)
      expect(counter.lookups).toBe(2)
    }, 10_000)

    it('a live wake that drains 120 events makes two lookups', async () => {
      const { ctx: lookupCtx, counter } = countingLookupCtx()
      const { generator, abortController } = subscribe(lookupCtx)

      const parked = parkedOnWake()
      const pending = generator.next()
      await parked
      await appendBacklog(120)
      sequenceEvents.emit(AUTHOR_DID)
      const first = await pending
      const rest = []
      for (let delivered = 1; delivered < 120; delivered++) {
        rest.push(await generator.next())
      }
      abortController.abort()

      expect([first, ...rest].every((frame) => !frame.done)).toBe(true)
      expect(counter.lookups).toBe(2)
    }, 10_000)

    it('a page whose events are all out of scope makes no lookup', async () => {
      await appendBacklog(30, OTHER_BOUNDARY)
      const { ctx: lookupCtx, counter } = countingLookupCtx()

      const frames = await framesUntilIdle(lookupCtx)

      expect(frames).toEqual([])
      expect(counter.lookups).toBe(0)
    })
  })

  describe('(e7) a page costs at most one record-state query and one label query', () => {
    function budgetCtx() {
      const calls = { states: 0, labels: [] as string[][] }
      const base = ctxWithTakedownLookup((uris, real) => {
        calls.states++
        return real(uris)
      })
      const budgetCtx = {
        ...base,
        labelStore: {
          latestTakedowns: (keys: string[]) => {
            calls.labels.push([...keys].sort())
            return ctx.labelStore.latestTakedowns(keys)
          },
        },
      }
      return { calls, ctx: budgetCtx }
    }

    it('makes one state call and no label call when every candidate has a row', async () => {
      await createPost('ayanami')
      await createPost('soryu')
      const { calls, ctx: spyCtx } = budgetCtx()

      const frames = await framesUntilIdle(spyCtx)

      expect(frames).toHaveLength(2)
      expect(calls.states).toBe(1)
      expect(calls.labels).toEqual([])
    })

    it('makes one state call and one label call, for the rowless URIs only, when a candidate has no row', async () => {
      await createPost('ayanami')
      await appendEvent([valueOp('create', 'kaworu')])
      await appendEvent([valueOp('update', 'nagisa')])
      const { calls, ctx: spyCtx } = budgetCtx()

      await framesUntilIdle(spyCtx)

      expect(calls.states).toBe(1)
      expect(calls.labels).toEqual([[uriOf('kaworu'), uriOf('nagisa')]])
    })

    it('makes neither call when the page has no create or update candidates', async () => {
      await appendEvent([deleteOp('ayanami')])
      await appendEvent([deleteOp('soryu')])
      const { calls, ctx: spyCtx } = budgetCtx()

      const frames = await framesUntilIdle(spyCtx)

      expect(frames).toHaveLength(2)
      expect(calls.states).toBe(0)
      expect(calls.labels).toEqual([])
    })
  })

  it('(e8) a failed label read ends the stream without sending the page', async () => {
    await createPost('ayanami')
    await appendEvent([valueOp('create', 'kaworu')])
    vi.spyOn(ctx.labelStore, 'latestTakedowns').mockRejectedValue(
      new Error('MAGI label log unreachable'),
    )
    const { generator, abortController } = subscribe(ctx)

    await expect(generator.next()).rejects.toThrow('MAGI label log unreachable')
    abortController.abort()

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      { did: AUTHOR_DID, err: expect.any(Error) },
      'takedown lookup failed',
    )
  })

  it('(s8) a delete op for a taken-down record is still delivered', async () => {
    await indexPost('ayanami')
    await setTakedown('ayanami', true)
    await appendEvent([
      {
        action: 'delete',
        path: `${POST}/ayanami`,
        boundary: { values: [{ value: SHARED_BOUNDARY }] },
      },
    ])

    const frames = await framesUntilIdle()

    expect(frames).toHaveLength(1)
    expect(frames[0].ops).toEqual([
      expect.objectContaining({ action: 'delete', path: `${POST}/ayanami` }),
    ])
  })

  it('(s9) a failed takedown lookup ends the stream without sending the page', async () => {
    await createPost('ayanami')
    await createPost('soryu')
    await setTakedown('ayanami', true)
    const failingCtx = ctxWithTakedownLookup(async () => {
      throw new Error('MAGI takedown index unreachable')
    })
    const { generator, abortController } = subscribe(failingCtx)

    await expect(generator.next()).rejects.toThrow(
      'MAGI takedown index unreachable',
    )
    abortController.abort()

    const failureWarn = failingCtx.logger.warn.mock.calls.find(
      ([, message]: [unknown, unknown]) => message === 'takedown lookup failed',
    )
    expect(failureWarn?.[0]).toMatchObject({
      did: AUTHOR_DID,
      err: expect.any(Error),
    })
  })

  function deleteOp(rkey: string, boundary = SHARED_BOUNDARY): FixtureOp {
    return {
      action: 'delete',
      path: `${POST}/${rkey}`,
      boundary: { values: [{ value: boundary }] },
    }
  }

  it('(r6a) a replay delivers the delete of a record whose recreated value is taken down', async () => {
    await indexPost('ayanami')
    await appendEvent([valueOp('create', 'ayanami')])
    await appendEvent([deleteOp('ayanami')])
    await appendEvent([valueOp('create', 'ayanami')])
    await setTakedown('ayanami', true)

    const frames = await framesUntilIdle()

    expect(frames.map((frame) => frame.seq)).toEqual([2])
    expect(frames[0].ops).toEqual([
      expect.objectContaining({ action: 'delete', path: `${POST}/ayanami` }),
    ])
  })

  it('(r6b) the takedown lookup receives the create and update URIs and never a delete URI', async () => {
    await indexPost('ayanami')
    await indexPost('soryu')
    await appendEvent([
      valueOp('create', 'ayanami'),
      valueOp('update', 'soryu'),
      deleteOp('katsuragi'),
    ])
    const lookedUp: string[][] = []
    const lookupCtx = ctxWithTakedownLookup((uris, real) => {
      lookedUp.push([...uris].sort())
      return real(uris)
    })

    const frames = await framesUntilIdle(lookupCtx)

    expect(frames).toHaveLength(1)
    expect(lookedUp).toEqual([[uriOf('ayanami'), uriOf('soryu')]])
  })

  it('(r6c) an abort after the first frame of a page ends the stream before the next event is counted', async () => {
    await appendBacklog(3)
    const recordSyncEvent = vi.spyOn(serviceMetrics, 'recordSyncEvent')
    try {
      const { generator, abortController } = subscribe()

      const first = await generator.next()
      abortController.abort()
      const rest = await generator.next()

      expect(first.done).toBe(false)
      expect(rest.done).toBe(true)
      expect(
        recordSyncEvent.mock.calls.filter(([outcome]) => outcome === 'applied'),
      ).toHaveLength(1)
    } finally {
      recordSyncEvent.mockRestore()
    }
  })

  it('(r6d) an undecodable event between two in-scope events is dropped and logged, and both neighbours arrive', async () => {
    await createPost('ayanami')
    await actorStore.transact(AUTHOR_DID, async (store) => {
      await store.sequence.appendEvent({
        did: AUTHOR_DID,
        eventType: 'append',
        event: Buffer.from([0xff, 0xfe, 0xfd]),
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })
    await createPost('soryu')

    const frames = await framesUntilIdle()

    expect(frames.map((frame) => frame.seq)).toEqual([1, 3])
    expect(framePaths(frames)).toEqual([`${POST}/ayanami`, `${POST}/soryu`])
    const dropWarnings = ctx.logger.warn.mock.calls.filter(
      ([, message]: [unknown, unknown]) =>
        message ===
        'subscribeRecords: dropping undecodable event (fail closed)',
    )
    expect(dropWarnings).toHaveLength(1)
    expect(dropWarnings[0][0]).toEqual({ did: AUTHOR_DID, seq: 2 })
  })
})
