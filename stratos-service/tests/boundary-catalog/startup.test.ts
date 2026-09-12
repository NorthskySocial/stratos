import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StratosServer } from '../../src/index.js'
import * as contextModule from '../../src/context.js'
import type { AppContext, EnrollmentEvent } from '../../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
} from '../../src/db/index.js'
import { SqliteEnrollmentStore } from '../../src/storage/sqlite/enrollment-store.js'
import { verifyBoundaryOperation } from '../../src/features/boundary-audit/model.js'
import { createTestConfig } from '../utils/index.js'
import {
  cborToRecord,
  createMockBlobStoreCreator,
} from '../helpers/test-env.js'
import { ENGINEERING, GENERAL, SERVICE, settings } from './helpers.js'

const FEEDGEN = 'did:web:bebop.example'
const SPIKE = 'did:plc:spike'
const DESIGN = `${SERVICE}/design`

describe('boundary catalog production startup wiring', () => {
  let dir: string
  const servers = new Set<StratosServer>()
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stratos-catalog-startup-'))
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const server of servers) await server.stop()
    servers.clear()
    await rm(dir, { recursive: true, force: true })
  })

  function config() {
    const cfg = createTestConfig(dir)
    cfg.service.did = SERVICE
    cfg.enrollment.serviceEnrollments = [
      { did: FEEDGEN, boundaries: [ENGINEERING] },
    ]
    return cfg
  }

  async function create(cfg = config()) {
    // Creating without listening performs real startup reconciliation while
    // leaving the PDS worker idle: this fixture never contacts an authority.
    const server = await StratosServer.create(
      cfg,
      createMockBlobStoreCreator(),
      cborToRecord,
      logger,
    )
    servers.add(server)
    return server
  }

  async function stop(server: StratosServer) {
    await server.stop()
    servers.delete(server)
  }

  async function enroll(ctx: AppContext) {
    await ctx.enrollmentStore.enroll({
      did: SPIKE,
      boundaries: [ENGINEERING, DESIGN],
      active: true,
      enrolledAt: '2026-09-12T15:00:00.000Z',
      signingKeyDid: ctx.signingDidKey,
    })
  }

  it('seeds service membership once and preserves admin grants and removals across restart', async () => {
    let server = await create()
    expect(logger.info).toHaveBeenCalledWith(
      { did: FEEDGEN, boundaries: 1 },
      'reconciled service enrollment',
    )
    expect(
      await server.ctx.enrollmentStore.getEnrollment(FEEDGEN),
    ).toMatchObject({
      active: true,
      isService: true,
      signingKeyDid: server.ctx.signingDidKey,
    })
    expect(
      (await server.ctx.enrollmentStore.getBoundaries(FEEDGEN)).sort(),
    ).toEqual([ENGINEERING, GENERAL].sort())
    const created = await server.ctx.boundaryManager!.create('bebop', settings)
    await server.ctx.enrollmentStore.removeBoundary(FEEDGEN, ENGINEERING)
    await server.ctx.enrollmentStore.addBoundary(FEEDGEN, created.boundary)
    const signingKey = server.ctx.signingDidKey
    await stop(server)

    server = await create()
    expect(server.ctx.signingDidKey).toBe(signingKey)
    expect(await server.ctx.boundaryStore!.get(created.boundary)).toMatchObject(
      {
        displayName: settings.displayName,
        status: 'active',
      },
    )
    expect(
      (await server.ctx.enrollmentStore.getBoundaries(FEEDGEN)).sort(),
    ).toEqual([created.boundary, GENERAL].sort())
    await server.ctx.enrollmentStore.removeBoundary(FEEDGEN, created.boundary)
    await stop(server)
    server = await create()
    expect(await server.ctx.enrollmentStore.getBoundaries(FEEDGEN)).toEqual([
      GENERAL,
    ])
  })

  it('rejects unknown configured boundaries and destroys the initialized context', async () => {
    const originalCreate = contextModule.createAppContext
    let initialized: AppContext | undefined
    const destroys = vi.fn()
    vi.spyOn(contextModule, 'createAppContext').mockImplementation(
      async (opts) => {
        const ctx = await originalCreate(opts)
        initialized = ctx
        const destroy = ctx.destroy.bind(ctx)
        vi.spyOn(ctx, 'destroy').mockImplementation(async () => {
          destroys()
          await destroy()
        })
        return ctx
      },
    )
    const cfg = config()
    cfg.enrollment.serviceEnrollments[0]!.boundaries = [`${SERVICE}/unknown`]
    try {
      await expect(create(cfg)).rejects.toThrow(
        `Service enrollment references unknown boundary: ${SERVICE}/unknown`,
      )
      expect(destroys).toHaveBeenCalledOnce()
      expect(await initialized!.checkHealth()).toMatchObject({
        status: 'error',
        components: { db: 'error' },
      })
    } finally {
      // Also release resources if a regression omits the failure cleanup.
      if (initialized && destroys.mock.calls.length === 0)
        await initialized.destroy()
    }
  })

  it('normalizes legacy SQLite memberships through signed audit and durable PDS sync before serving', async () => {
    const db = createServiceDb(join(dir, 'service.sqlite'))
    await migrateServiceDb(db)
    try {
      await new SqliteEnrollmentStore(db).enroll({
        did: SPIKE,
        boundaries: ['engineering', 'general'],
        active: true,
        enrolledAt: '2026-09-12T15:00:00.000Z',
        signingKeyDid: 'did:key:spike',
      })
    } finally {
      await closeServiceDb(db)
    }
    let server = await create()
    expect(
      (await server.ctx.enrollmentStore.getBoundaries(SPIKE)).sort(),
    ).toEqual([ENGINEERING, GENERAL].sort())
    const history = await server.ctx.boundaryAudit.list(SPIKE)
    expect(history.operations).toHaveLength(1)
    const signed = history.operations[0]!
    expect(signed.operation).toMatchObject({
      authority: SERVICE,
      did: SPIKE,
      signingKey: server.ctx.signingDidKey,
      before: { boundaries: ['engineering', 'general'] },
      after: { boundaries: [ENGINEERING, GENERAL].sort() },
    })
    expect(await verifyBoundaryOperation(signed)).toBe(true)
    expect(await server.ctx.pdsSyncQueue.list(10)).toEqual([
      expect.objectContaining({ did: SPIKE, status: 'pending', generation: 2 }),
    ])
    await stop(server)
    server = await create()
    expect((await server.ctx.boundaryAudit.list(SPIKE)).operations).toEqual(
      history.operations,
    )
    expect(await server.ctx.pdsSyncQueue.list(10)).toEqual([
      expect.objectContaining({ did: SPIKE, status: 'pending', generation: 2 }),
    ])
  })

  it('deactivation queues durable intent before and after removal and emits prior and remaining boundaries', async () => {
    const { ctx } = await create()
    await enroll(ctx)
    const events: EnrollmentEvent[] = []
    ctx.enrollmentEvents.on('enrollment', (event) => events.push(event))
    const raw = new SqliteEnrollmentStore(ctx.db!)
    const observedMemberships: string[][] = []
    const enqueue = ctx.pdsSyncWorker.enqueue.bind(ctx.pdsSyncWorker)
    vi.spyOn(ctx.pdsSyncWorker, 'enqueue').mockImplementation(async (did) => {
      if (did === SPIKE) observedMemberships.push(await raw.getBoundaries(did))
      return enqueue(did)
    })
    expect(await ctx.boundaryManager!.deactivate(ENGINEERING, 1)).toMatchObject(
      {
        status: 'inactive',
        memberCount: 0,
      },
    )
    expect(observedMemberships).toHaveLength(2)
    expect(observedMemberships[0]).toContain(ENGINEERING)
    expect(observedMemberships[1]).not.toContain(ENGINEERING)
    const event = events.find((event) => event.did === SPIKE)!
    expect(event.action).toBe('boundaries')
    expect(event.boundaries!.sort()).toEqual([DESIGN, GENERAL].sort())
    expect(event.priorBoundaries!.sort()).toEqual(
      [DESIGN, ENGINEERING, GENERAL].sort(),
    )
    expect(Number.isFinite(Date.parse(event.time))).toBe(true)
    expect(await ctx.pdsSyncQueue.list(10)).toContainEqual(
      expect.objectContaining({ did: SPIKE, status: 'pending', generation: 2 }),
    )
  })

  it('logs a failed post-removal enqueue and retries the durable invalidation with its prior boundary', async () => {
    const cfg = config()
    cfg.enrollment.serviceEnrollments = []
    const { ctx } = await create(cfg)
    await enroll(ctx)
    const events: EnrollmentEvent[] = []
    ctx.enrollmentEvents.on('enrollment', (event) => events.push(event))
    const failure = new Error('Bebop queue temporarily unavailable')
    const enqueue = ctx.pdsSyncWorker.enqueue.bind(ctx.pdsSyncWorker)
    const enqueueSpy = vi
      .spyOn(ctx.pdsSyncWorker, 'enqueue')
      .mockImplementationOnce(enqueue)
      .mockRejectedValueOnce(failure)
    expect(await ctx.boundaryManager!.deactivate(ENGINEERING, 1)).toMatchObject(
      {
        status: 'deactivating',
      },
    )
    expect(
      await new SqliteEnrollmentStore(ctx.db!).getBoundaries(SPIKE),
    ).not.toContain(ENGINEERING)
    expect(events).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure },
      'boundary deactivation will retry',
    )
    enqueueSpy.mockRestore()
    await ctx.boundaryManager!.drain()
    expect(await ctx.boundaryStore!.get(ENGINEERING)).toMatchObject({
      status: 'inactive',
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.priorBoundaries!.sort()).toEqual(
      [DESIGN, ENGINEERING, GENERAL].sort(),
    )
    expect(events[0]!.boundaries!.sort()).toEqual([DESIGN, GENERAL].sort())
    expect(await ctx.pdsSyncQueue.list(10)).toEqual([
      expect.objectContaining({ did: SPIKE, status: 'pending', generation: 3 }),
    ])
  })

  it('stops the boundary worker before closing the persistent store', async () => {
    const server = await create()
    const originalStop = server.ctx.boundaryManager!.stop.bind(
      server.ctx.boundaryManager,
    )
    const healthyWhileStopping: string[] = []
    const stopping = vi
      .spyOn(server.ctx.boundaryManager!, 'stop')
      .mockImplementation(async () => {
        healthyWhileStopping.push((await server.ctx.checkHealth()).status)
        await originalStop()
      })
    await stop(server)
    expect(stopping).toHaveBeenCalledOnce()
    expect(healthyWhileStopping).toEqual(['ok'])
    expect((await server.ctx.checkHealth()).status).toBe('error')
  })
  it('keeps failed deactivation resumable when no logger was supplied', async () => {
    const cfg = config()
    cfg.enrollment.serviceEnrollments = []
    const server = await StratosServer.create(
      cfg,
      createMockBlobStoreCreator(),
      cborToRecord,
    )
    servers.add(server)
    await enroll(server.ctx)
    const enqueue = vi
      .spyOn(server.ctx.pdsSyncWorker, 'enqueue')
      .mockRejectedValueOnce(new Error('Queue unavailable'))
    await expect(
      server.ctx.boundaryManager!.deactivate(ENGINEERING, 1),
    ).resolves.toMatchObject({ status: 'deactivating' })
    enqueue.mockRestore()
    await server.ctx.boundaryManager!.drain()
    expect(await server.ctx.boundaryStore!.get(ENGINEERING)).toMatchObject({
      status: 'inactive',
    })
  })
})
