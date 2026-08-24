import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext } from '../src'
import type { EnrollmentEventEmitter } from '../src/context-types.js'
import type { EnrollmentStore } from '../src/oauth'
import {
  PdsEnrollmentSyncWorker,
  registerEnrollmentHandlers,
  syncEnrollmentRecordToPds,
  type PdsSyncJob,
  type PdsSyncQueueStore,
} from '../src/features'

// The boundary handlers write the user's PDS enrollment record through an
// `Agent` constructed inside `syncEnrollmentRecordToPds`. Stub it so the PDS
// write is deterministic: by default it succeeds (pdsSync: 'ok'); a failure is
// injected per-test by making `oauthClient.restore` throw before the Agent is
// ever built. The mock must be a real constructor (class), not an arrow
// function — `new Agent(...)` would otherwise throw "not a constructor".
vi.mock('@atproto/api', () => ({
  Agent: class {
    com = {
      atproto: {
        repo: {
          putRecord: async () => ({}),
        },
      },
    }
    constructor(_session: unknown) {}
  },
}))

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokePostRoute(
  app: express.Application,
  path: string,
  body: unknown,
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query: {},
      body,
      headers: {},
      method: 'POST',
      url: path,
      _body: true, // Signal to express.json that body is already parsed
    } as unknown as express.Request
    const res = {
      status(code: number) {
        statusCode = code
        return res
      },
      json(responseBody: unknown) {
        resolve({ statusCode, body: responseBody })
        return res
      },
      setHeader() {
        return res
      },
    } as unknown as express.Response

    // In Express 4, app.handle doesn't always work as expected for manual routing
    // especially with the router stack. Let's try to call the app directly.
    app(req, res, (err?: any) => {
      if (err) return reject(err)
      resolve({ statusCode, body: null })
    })
  })
}

function invokeGetRoute(
  app: express.Application,
  path: string,
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query: {},
      headers: {},
      method: 'GET',
      url: path,
    } as unknown as express.Request
    const res = {
      status(code: number) {
        statusCode = code
        return res
      },
      json(responseBody: unknown) {
        resolve({ statusCode, body: responseBody })
        return res
      },
      setHeader() {
        return res
      },
    } as unknown as express.Response

    app(req, res, (err?: any) => {
      if (err) return reject(err)
      resolve({ statusCode, body: null })
    })
  })
}

function createMockStore(
  overrides: Partial<EnrollmentStore> = {},
): EnrollmentStore {
  return {
    isEnrolled: vi.fn(async () => true),
    getEnrollment: vi.fn(async () => ({
      did: 'did:plc:usagi',
      enrolledAt: '2026-01-01T00:00:00.000Z',
      pdsEndpoint: 'https://pds.example.com',
      signingKeyDid: 'did:key:zSailorMoon',
      active: true,
      enrollmentRkey: 'rkey123',
    })),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    getBoundaries: vi.fn(async () => ['did:web:nerv.tokyo.jp/posters-madness']),
    setBoundaries: vi.fn(async () => {}),
    addBoundary: vi.fn(async () => {}),
    removeBoundary: vi.fn(async () => {}),
    ...overrides,
  }
}

/** In-memory queue so the real worker's bookkeeping is observable per test. */
class InMemoryPdsSyncQueue implements PdsSyncQueueStore {
  jobs = new Map<string, PdsSyncJob>()

  async upsertPending(did: string): Promise<number> {
    const now = new Date().toISOString()
    const existing = this.jobs.get(did)
    const generation = (existing?.generation ?? 0) + 1
    this.jobs.set(did, {
      did,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      firstQueuedAt: existing?.firstQueuedAt ?? now,
      updatedAt: now,
      lastError: null,
      generation,
    })
    return generation
  }

  async listDue(now: string, limit: number): Promise<PdsSyncJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'pending' && j.nextAttemptAt <= now)
      .slice(0, limit)
  }

  async markRetry(
    did: string,
    generation: number,
    attemptCount: number,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    const job = this.jobs.get(did)
    if (!job || job.generation !== generation) return
    this.jobs.set(did, { ...job, attemptCount, nextAttemptAt, lastError })
  }

  async markFailed(
    did: string,
    generation: number,
    lastError: string,
  ): Promise<void> {
    const job = this.jobs.get(did)
    if (!job || job.generation !== generation) return
    this.jobs.set(did, { ...job, status: 'failed', lastError })
  }

  async removeIfCurrent(did: string, generation: number): Promise<boolean> {
    const job = this.jobs.get(did)
    if (!job || job.generation !== generation) return false
    this.jobs.delete(did)
    return true
  }

  async remove(did: string): Promise<void> {
    this.jobs.delete(did)
  }

  async requeueFailed(): Promise<number> {
    const now = new Date().toISOString()
    let requeued = 0
    for (const [did, job] of this.jobs) {
      if (job.status !== 'failed') continue
      this.jobs.set(did, {
        ...job,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        updatedAt: now,
        lastError: null,
        generation: job.generation + 1,
      })
      requeued += 1
    }
    return requeued
  }

  async list(): Promise<PdsSyncJob[]> {
    return [...this.jobs.values()]
  }
}

function createCtx(opts: {
  enrollmentStore?: Partial<EnrollmentStore>
  adminAuthFails?: boolean
  pdsWriteFails?: boolean
}): {
  ctx: AppContext
  enrollmentStore: EnrollmentStore
  app: express.Application
  enrollmentEvents: EnrollmentEventEmitter
  pdsSyncQueue: InMemoryPdsSyncQueue
} {
  const enrollmentStore = createMockStore(opts.enrollmentStore)

  const app = express()

  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()

  const oauthClient = {
    restore: opts.pdsWriteFails
      ? vi.fn(async () => {
          throw new Error('oauth session expired')
        })
      : vi.fn(async () => ({})),
  }

  const createAttestation = vi.fn(async () => ({
    sig: new Uint8Array([1, 2, 3]),
    signingKey: 'did:key:zTestKey',
  }))

  const pdsSyncQueue = new InMemoryPdsSyncQueue()
  const pdsSyncWorker = new PdsEnrollmentSyncWorker(
    {
      queue: pdsSyncQueue,
      sync: (did) =>
        syncEnrollmentRecordToPds(
          {
            enrollmentStore: enrollmentStore as never,
            createAttestation,
            oauthClient: oauthClient as never,
            serviceDid: 'did:web:stratos.example.com',
            publicUrl: 'https://stratos.example.com',
          },
          did,
        ),
    },
    {
      tickMs: 30_000,
      backoffBaseMs: 30_000,
      backoffCapMs: 3_600_000,
      maxAttempts: 12,
      claimLimit: 10,
    },
  )

  const ctx = {
    app,
    enrollmentStore,
    enrollmentEvents,
    pdsSyncQueue,
    pdsSyncWorker,
    enrollmentService: {
      isEnrolled: enrollmentStore.isEnrolled,
      getEnrollment: vi.fn(),
    },
    boundaryResolver: { getBoundaries: vi.fn(async () => []) },
    authVerifier: {
      admin: opts.adminAuthFails
        ? vi.fn(async () => {
            throw new Error('Unauthorized')
          })
        : vi.fn(async () => ({ credentials: { type: 'admin' } })),
      optionalStandard: vi.fn(async () => ({
        credentials: { did: null },
      })),
    },
    oauthClient,
    serviceDid: 'did:web:stratos.example.com',
    createAttestation,
    cfg: {
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: {
        serviceDid: 'did:web:nerv.tokyo.jp',
        allowedDomains: [
          'did:web:nerv.tokyo.jp/posters-madness',
          'did:web:nerv.tokyo.jp/bees',
          'did:web:nerv.tokyo.jp/plants',
        ],
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as AppContext

  const xrpcServer = {
    method: vi.fn(),
  }

  registerEnrollmentHandlers(xrpcServer as any, ctx)
  // Ensure the router is initialized for tests that look into _router
  // ;(app as any)._router = (app as any)._router || express.Router()
  return { ctx, enrollmentStore, app, enrollmentEvents, pdsSyncQueue }
}

describe('admin boundary endpoints', () => {
  vi.setConfig({ testTimeout: 15000 })
  describe('POST /xrpc/zone.stratos.admin.addBoundary', () => {
    it('adds a boundary to an enrolled user', async () => {
      const { app, enrollmentStore, pdsSyncQueue } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'did:web:nerv.tokyo.jp/bees' },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as {
        did: string
        boundaries: string[]
        pdsSync: string
      }
      expect(body.did).toBe('did:plc:usagi')
      expect(body.boundaries).toBeDefined()
      expect(body.pdsSync).toBe('ok')
      expect(enrollmentStore.addBoundary).toHaveBeenCalledWith(
        'did:plc:usagi',
        'did:web:nerv.tokyo.jp/bees',
      )
      // The inline sync succeeded, so no durable job remains.
      expect(pdsSyncQueue.jobs.size).toBe(0)
    })

    it('reports pdsSync deferred and leaves a pending job on PDS write failure', async () => {
      const { app, enrollmentStore, pdsSyncQueue } = createCtx({
        pdsWriteFails: true,
      })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'did:web:nerv.tokyo.jp/bees' },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as { boundaries: string[]; pdsSync: string }
      expect(body.pdsSync).toBe('deferred')
      // The local store mutation is still applied; only PDS propagation failed.
      expect(enrollmentStore.addBoundary).toHaveBeenCalled()
      // Durable intent survives for the background worker to retry.
      const job = pdsSyncQueue.jobs.get('did:plc:usagi')
      expect(job?.status).toBe('pending')
      expect(job?.attemptCount).toBe(1)
    })

    it('rejects unauthenticated requests', async () => {
      const { app } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'did:web:nerv.tokyo.jp/bees' },
      )
      expect(res.statusCode).toBe(401)
    })

    it('rejects missing boundary field', async () => {
      const { app } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi' },
      )
      expect(res.statusCode).toBe(400)
      expect((res.body as { error: string }).error).toBe('InvalidRequest')
    })

    it('rejects boundaries not in allowed domains', async () => {
      const { app } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/forbidden-domain',
        },
      )
      expect(res.statusCode).toBe(400)
      expect((res.body as { message: string }).message).toContain(
        'not in allowed domains',
      )
    })

    it('returns 404 for unenrolled users', async () => {
      const { app } = createCtx({
        enrollmentStore: { isEnrolled: vi.fn(async () => false) },
      })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:nobody', boundary: 'did:web:nerv.tokyo.jp/bees' },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /xrpc/zone.stratos.admin.removeBoundary', () => {
    it('removes a boundary from an enrolled user', async () => {
      const { app, enrollmentStore } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.removeBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/posters-madness',
        },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as {
        did: string
        boundaries: string[]
        pdsSync: string
      }
      expect(body.did).toBe('did:plc:usagi')
      expect(body.pdsSync).toBe('ok')
      expect(enrollmentStore.removeBoundary).toHaveBeenCalledWith(
        'did:plc:usagi',
        'did:web:nerv.tokyo.jp/posters-madness',
      )
    })

    it('reports pdsSync deferred on PDS write failure', async () => {
      const { app, enrollmentStore, pdsSyncQueue } = createCtx({
        pdsWriteFails: true,
      })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.removeBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/posters-madness',
        },
      )
      expect(res.statusCode).toBe(200)
      expect((res.body as { pdsSync: string }).pdsSync).toBe('deferred')
      expect(enrollmentStore.removeBoundary).toHaveBeenCalled()
      expect(pdsSyncQueue.jobs.get('did:plc:usagi')?.status).toBe('pending')
    })

    it('rejects unauthenticated requests', async () => {
      const { app } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.removeBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/posters-madness',
        },
      )
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 for unenrolled users', async () => {
      const { app } = createCtx({
        enrollmentStore: { isEnrolled: vi.fn(async () => false) },
      })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.removeBoundary',
        {
          did: 'did:plc:nobody',
          boundary: 'did:web:nerv.tokyo.jp/posters-madness',
        },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /xrpc/zone.stratos.admin.setBoundaries', () => {
    it('sets boundaries for an enrolled user', async () => {
      const { app, enrollmentStore } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        {
          did: 'did:plc:usagi',
          boundaries: [
            'did:web:nerv.tokyo.jp/bees',
            'did:web:nerv.tokyo.jp/plants',
          ],
        },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as {
        did: string
        boundaries: string[]
        pdsSync: string
      }
      expect(body.did).toBe('did:plc:usagi')
      expect(body.pdsSync).toBe('ok')
      expect(enrollmentStore.setBoundaries).toHaveBeenCalledWith(
        'did:plc:usagi',
        ['did:web:nerv.tokyo.jp/bees', 'did:web:nerv.tokyo.jp/plants'],
      )
    })

    it('reports pdsSync deferred on PDS write failure', async () => {
      const { app, enrollmentStore, pdsSyncQueue } = createCtx({
        pdsWriteFails: true,
      })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        {
          did: 'did:plc:usagi',
          boundaries: ['did:web:nerv.tokyo.jp/bees'],
        },
      )
      expect(res.statusCode).toBe(200)
      expect((res.body as { pdsSync: string }).pdsSync).toBe('deferred')
      expect(enrollmentStore.setBoundaries).toHaveBeenCalled()
      expect(pdsSyncQueue.jobs.get('did:plc:usagi')?.status).toBe('pending')
    })

    it('allows setting empty boundaries', async () => {
      const { app } = createCtx({
        enrollmentStore: { getBoundaries: vi.fn(async () => []) },
      })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi', boundaries: [] },
      )
      expect(res.statusCode).toBe(200)
      expect((res.body as { boundaries: string[] }).boundaries).toEqual([])
    })

    it('rejects invalid boundaries', async () => {
      const { app } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        {
          did: 'did:plc:usagi',
          boundaries: [
            'did:web:nerv.tokyo.jp/bees',
            'did:web:nerv.tokyo.jp/not-allowed',
          ],
        },
      )
      expect(res.statusCode).toBe(400)
      expect((res.body as { message: string }).message).toContain(
        'did:web:nerv.tokyo.jp/not-allowed',
      )
    })

    it('rejects missing boundaries array', async () => {
      const { app } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi' },
      )
      expect(res.statusCode).toBe(400)
    })

    it('rejects unauthenticated requests', async () => {
      const { app } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi', boundaries: ['did:web:nerv.tokyo.jp/bees'] },
      )
      expect(res.statusCode).toBe(401)
    })
  })

  describe('GET /xrpc/zone.stratos.admin.listPdsSyncStatus', () => {
    it('returns queued jobs to an admin', async () => {
      const { app, pdsSyncQueue } = createCtx({ pdsWriteFails: true })
      await invokePostRoute(app, '/xrpc/zone.stratos.admin.addBoundary', {
        did: 'did:plc:usagi',
        boundary: 'did:web:nerv.tokyo.jp/bees',
      })

      const res = await invokeGetRoute(
        app,
        '/xrpc/zone.stratos.admin.listPdsSyncStatus',
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as { jobs: Array<{ did: string; status: string }> }
      expect(body.jobs).toHaveLength(1)
      expect(body.jobs[0].did).toBe('did:plc:usagi')
      expect(body.jobs[0].status).toBe('pending')
      expect(pdsSyncQueue.jobs.size).toBe(1)
    })

    it('returns an empty list when the queue is drained', async () => {
      const { app } = createCtx({})
      await invokePostRoute(app, '/xrpc/zone.stratos.admin.addBoundary', {
        did: 'did:plc:usagi',
        boundary: 'did:web:nerv.tokyo.jp/bees',
      })

      const res = await invokeGetRoute(
        app,
        '/xrpc/zone.stratos.admin.listPdsSyncStatus',
      )
      expect(res.statusCode).toBe(200)
      expect((res.body as { jobs: unknown[] }).jobs).toEqual([])
    })

    it('rejects unauthenticated requests', async () => {
      const { app } = createCtx({ adminAuthFails: true })
      const res = await invokeGetRoute(
        app,
        '/xrpc/zone.stratos.admin.listPdsSyncStatus',
      )
      expect(res.statusCode).toBe(401)
      expect(res.body).toEqual({
        error: 'AuthRequired',
        message: 'Admin auth required',
      })
    })

    it('passes the request context to the admin verifier', async () => {
      const { app, ctx } = createCtx({})
      await invokeGetRoute(app, '/xrpc/zone.stratos.admin.listPdsSyncStatus')

      expect(ctx.authVerifier.admin).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.anything(),
          res: expect.anything(),
        }),
      )
    })

    it('returns 500 when the queue read fails', async () => {
      const { app, ctx, pdsSyncQueue } = createCtx({})
      pdsSyncQueue.list = vi.fn().mockRejectedValue(new Error('db closed'))

      const res = await invokeGetRoute(
        app,
        '/xrpc/zone.stratos.admin.listPdsSyncStatus',
      )
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        error: 'InternalError',
        message: 'Failed to list PDS sync status',
      })
      expect(ctx.logger?.error).toHaveBeenCalledWith(
        { err: 'db closed' },
        'admin.listPdsSyncStatus failed',
      )
    })

    it('still answers 500 without a logger when the queue read fails', async () => {
      const { app, ctx, pdsSyncQueue } = createCtx({})
      ;(ctx as { logger?: unknown }).logger = undefined
      pdsSyncQueue.list = vi.fn().mockRejectedValue(new Error('db closed'))

      const res = await invokeGetRoute(
        app,
        '/xrpc/zone.stratos.admin.listPdsSyncStatus',
      )
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        error: 'InternalError',
        message: 'Failed to list PDS sync status',
      })
    })
  })

  describe('POST /xrpc/zone.stratos.admin.requeuePdsSync', () => {
    it('revives every failed job and reports the count', async () => {
      const { app, ctx, pdsSyncQueue } = createCtx({})
      const usagi = await pdsSyncQueue.upsertPending('did:plc:usagi')
      await pdsSyncQueue.markFailed('did:plc:usagi', usagi, 'invalid_grant')
      const rei = await pdsSyncQueue.upsertPending('did:plc:rei')
      await pdsSyncQueue.markFailed('did:plc:rei', rei, 'invalid_grant')
      await pdsSyncQueue.upsertPending('did:plc:ami')

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.requeuePdsSync',
        {},
      )

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ requeued: 2 })
      expect((await pdsSyncQueue.list()).map((j) => j.status)).toEqual([
        'pending',
        'pending',
        'pending',
      ])
      expect(ctx.logger?.info).toHaveBeenCalledWith(
        expect.objectContaining({ requeued: 2 }),
        'admin requeued PDS sync jobs',
      )
      expect(ctx.authVerifier.admin).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.anything(),
          res: expect.anything(),
        }),
      )
    })

    it('revives failed jobs when no logger is set', async () => {
      const { app, ctx, pdsSyncQueue } = createCtx({})
      ;(ctx as { logger?: unknown }).logger = undefined
      const usagi = await pdsSyncQueue.upsertPending('did:plc:usagi')
      await pdsSyncQueue.markFailed('did:plc:usagi', usagi, 'invalid_grant')

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.requeuePdsSync',
        {},
      )
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ requeued: 1 })
    })

    it('still answers 500 without a logger when the queue write fails', async () => {
      const { app, ctx, pdsSyncQueue } = createCtx({})
      ;(ctx as { logger?: unknown }).logger = undefined
      pdsSyncQueue.requeueFailed = vi
        .fn()
        .mockRejectedValue(new Error('db closed'))

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.requeuePdsSync',
        {},
      )
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        error: 'InternalError',
        message: 'Failed to requeue PDS sync jobs',
      })
    })

    it('reports zero when no job has failed', async () => {
      const { app, pdsSyncQueue } = createCtx({})
      await pdsSyncQueue.upsertPending('did:plc:usagi')

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.requeuePdsSync',
        {},
      )
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ requeued: 0 })
    })

    it('rejects unauthenticated requests', async () => {
      const { app } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.requeuePdsSync',
        {},
      )
      expect(res.statusCode).toBe(401)
      expect(res.body).toEqual({
        error: 'AuthRequired',
        message: 'Admin auth required',
      })
    })

    it('returns 500 when the queue write fails', async () => {
      const { app, ctx, pdsSyncQueue } = createCtx({})
      pdsSyncQueue.requeueFailed = vi
        .fn()
        .mockRejectedValue(new Error('db closed'))

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.requeuePdsSync',
        {},
      )
      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({
        error: 'InternalError',
        message: 'Failed to requeue PDS sync jobs',
      })
      expect(ctx.logger?.error).toHaveBeenCalledWith(
        { err: 'db closed' },
        'admin.requeuePdsSync failed',
      )
    })
  })

  describe('inline sync kick failure', () => {
    it('degrades to deferred instead of failing the committed mutation', async () => {
      const { app, ctx } = createCtx({})
      ctx.pdsSyncWorker.kick = vi
        .fn()
        .mockRejectedValue(new Error('queue write failed'))

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/bees',
        },
      )

      // The boundary change already committed; a queue failure must not
      // surface as a 500.
      expect(res.statusCode).toBe(200)
      expect((res.body as { pdsSync: string }).pdsSync).toBe('deferred')
      expect(ctx.logger?.warn).toHaveBeenCalledWith(
        { err: 'queue write failed', did: 'did:plc:usagi' },
        'pds sync attempt failed inline; job remains queued',
      )
    })

    it('degrades to deferred without a logger', async () => {
      const { app, ctx } = createCtx({})
      ;(ctx as { logger?: unknown }).logger = undefined
      ctx.pdsSyncWorker.kick = vi
        .fn()
        .mockRejectedValue(new Error('queue write failed'))

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/bees',
        },
      )

      expect(res.statusCode).toBe(200)
      expect((res.body as { pdsSync: string }).pdsSync).toBe('deferred')
    })
  })

  // An in-place boundary change must emit a `boundaries` event on
  // the service stream carrying `{did, boundaries-after}`, so downstream caches
  // invalidate without waiting for a TTL. Previously no stream
  // trigger existed for a boundary-set change.
  describe('boundary-change event emission', () => {
    interface CapturedEvent {
      did: string
      action: string
      boundaries?: string[]
      priorBoundaries?: string[]
    }

    function captureEvents(emitter: EnrollmentEventEmitter) {
      const events: CapturedEvent[] = []
      emitter.on('enrollment', (e) => events.push(e as CapturedEvent))
      return events
    }

    it('addBoundary emits a boundaries-after event', async () => {
      // prior (1st getBoundaries) → after (2nd getBoundaries) differ.
      const getBoundaries = vi
        .fn()
        .mockResolvedValueOnce(['did:web:nerv.tokyo.jp/posters-madness'])
        .mockResolvedValue([
          'did:web:nerv.tokyo.jp/posters-madness',
          'did:web:nerv.tokyo.jp/bees',
        ])
      const { app, enrollmentEvents } = createCtx({
        enrollmentStore: { getBoundaries },
      })
      const events = captureEvents(enrollmentEvents)

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'did:web:nerv.tokyo.jp/bees' },
      )
      expect(res.statusCode).toBe(200)

      expect(events).toHaveLength(1)
      expect(events[0].action).toBe('boundaries')
      expect(events[0].did).toBe('did:plc:usagi')
      expect(events[0].boundaries).toEqual([
        'did:web:nerv.tokyo.jp/posters-madness',
        'did:web:nerv.tokyo.jp/bees',
      ])
      expect(events[0].priorBoundaries).toEqual([
        'did:web:nerv.tokyo.jp/posters-madness',
      ])
    })

    it('removeBoundary emits a boundaries-after event reflecting the shrink', async () => {
      const getBoundaries = vi
        .fn()
        .mockResolvedValueOnce([
          'did:web:nerv.tokyo.jp/posters-madness',
          'did:web:nerv.tokyo.jp/bees',
        ])
        .mockResolvedValue(['did:web:nerv.tokyo.jp/bees'])
      const { app, enrollmentEvents } = createCtx({
        enrollmentStore: { getBoundaries },
      })
      const events = captureEvents(enrollmentEvents)

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.removeBoundary',
        {
          did: 'did:plc:usagi',
          boundary: 'did:web:nerv.tokyo.jp/posters-madness',
        },
      )
      expect(res.statusCode).toBe(200)

      expect(events).toHaveLength(1)
      expect(events[0].action).toBe('boundaries')
      expect(events[0].boundaries).toEqual(['did:web:nerv.tokyo.jp/bees'])
      expect(events[0].priorBoundaries).toEqual([
        'did:web:nerv.tokyo.jp/posters-madness',
        'did:web:nerv.tokyo.jp/bees',
      ])
    })

    it('setBoundaries emits the EFFECTIVE persisted set (re-read after write)', async () => {
      // The store decorator force-includes the reserved domain, so the emitted
      // event must carry the effective persisted set (re-read after the write),
      // not the requested boundaries. First read = prior; second = effective.
      const effective = [
        'did:web:nerv.tokyo.jp/bees',
        'did:web:nerv.tokyo.jp/plants',
        'did:web:nerv.tokyo.jp/general',
      ]
      const getBoundaries = vi
        .fn()
        .mockResolvedValueOnce(['did:web:nerv.tokyo.jp/posters-madness'])
        .mockResolvedValue(effective)
      const { app, enrollmentEvents } = createCtx({
        enrollmentStore: { getBoundaries },
      })
      const events = captureEvents(enrollmentEvents)

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        {
          did: 'did:plc:usagi',
          boundaries: [
            'did:web:nerv.tokyo.jp/bees',
            'did:web:nerv.tokyo.jp/plants',
          ],
        },
      )
      expect(res.statusCode).toBe(200)

      expect(events).toHaveLength(1)
      expect(events[0].action).toBe('boundaries')
      // The reserved 'general' domain — added by the store decorator, absent
      // from the request — is present, proving the handler re-read the store.
      expect(events[0].boundaries).toEqual(effective)
      // And the HTTP response reflects the effective set too.
      expect((res.body as { boundaries: string[] }).boundaries).toEqual(
        effective,
      )
    })

    it('is idempotent: no event when the boundary set is unchanged', async () => {
      // prior === after (mock returns the same set on both reads).
      const getBoundaries = vi
        .fn()
        .mockResolvedValue([
          'did:web:nerv.tokyo.jp/bees',
          'did:web:nerv.tokyo.jp/plants',
        ])
      const { app, enrollmentEvents } = createCtx({
        enrollmentStore: { getBoundaries },
      })
      const events = captureEvents(enrollmentEvents)

      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.setBoundaries',
        {
          did: 'did:plc:usagi',
          boundaries: [
            'did:web:nerv.tokyo.jp/plants',
            'did:web:nerv.tokyo.jp/bees',
          ],
        },
      )
      expect(res.statusCode).toBe(200)
      expect(events).toHaveLength(0)
    })
  })
})
