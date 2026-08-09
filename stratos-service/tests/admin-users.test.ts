import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext } from '../src'
import type { EnrollmentEventEmitter } from '../src/context-types.js'
import type { EnrollmentStore } from '../src/oauth'
import { registerEnrollmentHandlers } from '../src/features'

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokeRoute(
  app: express.Application,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query: {},
      body,
      headers: {},
      method,
      url: path,
      _body: true, // Signal to express.json that the body is already parsed
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

    app(req, res, (err?: unknown) => {
      if (err) {
        return reject(
          err instanceof Error
            ? err
            : new Error(`express next() called with: ${inspect(err)}`),
        )
      }
      resolve({ statusCode, body: null })
    })
  })
}

const VIEWER = 'did:plc:haruki'
const CONFIG_ADMIN = 'did:plc:configured'

interface AdminUserStoreStub {
  list: ReturnType<typeof vi.fn>
  has: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function createCtx(opts: {
  adminUserStore?: Partial<AdminUserStoreStub>
  adminDids?: string[]
  adminAuthFails?: boolean
}): { app: express.Application; adminUserStore: AdminUserStoreStub } {
  const adminUserStore: AdminUserStoreStub = {
    list: vi.fn(async () => []),
    has: vi.fn(async () => true),
    add: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...opts.adminUserStore,
  }

  const app = express()
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()

  const ctx = {
    app,
    adminUserStore,
    enrollmentStore: {
      isEnrolled: vi.fn(async () => true),
      getEnrollment: vi.fn(async () => null),
      getBoundaries: vi.fn(async () => []),
      updateEnrollment: vi.fn(async () => {}),
      listEnrollments: vi.fn(async () => []),
      enrollmentCount: vi.fn(async () => 0),
    } as unknown as EnrollmentStore,
    enrollmentEvents,
    enrollmentService: { isEnrolled: vi.fn(), getEnrollment: vi.fn() },
    boundaryResolver: { getBoundaries: vi.fn(async () => []) },
    authVerifier: {
      admin: opts.adminAuthFails
        ? vi.fn(async () => {
            throw new Error('Unauthorized')
          })
        : vi.fn(async () => ({
            credentials: { type: 'admin', did: VIEWER },
          })),
      optionalStandard: vi.fn(async () => ({ credentials: { did: null } })),
    },
    serviceDid: 'did:web:nerv.tokyo.jp',
    cfg: {
      adminDids: opts.adminDids ?? [CONFIG_ADMIN],
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: {
        serviceDid: 'did:web:nerv.tokyo.jp',
        allowedDomains: ['did:web:nerv.tokyo.jp/general'],
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext

  registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
  return { app, adminUserStore }
}

const LIST = '/xrpc/zone.stratos.admin.listAdmins'
const ADD = '/xrpc/zone.stratos.admin.addAdmin'
const REMOVE = '/xrpc/zone.stratos.admin.removeAdmin'

describe('admin management endpoints', () => {
  describe('GET listAdmins', () => {
    it('rejects unauthenticated callers', async () => {
      const { app, adminUserStore } = createCtx({ adminAuthFails: true })

      const res = await invokeRoute(app, 'GET', LIST)

      expect(res.statusCode).toBe(401)
      expect(adminUserStore.list).not.toHaveBeenCalled()
    })

    it('returns config and granted admins tagged by source', async () => {
      const { app } = createCtx({
        adminUserStore: {
          list: vi.fn(async () => [
            {
              did: 'did:plc:motoko',
              addedAt: '2026-02-02T00:00:00.000Z',
              addedBy: VIEWER,
            },
          ]),
        },
      })

      const res = await invokeRoute(app, 'GET', LIST)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({
        admins: [
          { did: CONFIG_ADMIN, source: 'config' },
          {
            did: 'did:plc:motoko',
            source: 'database',
            addedAt: '2026-02-02T00:00:00.000Z',
            addedBy: VIEWER,
          },
        ],
        viewer: VIEWER,
      })
    })

    it('lists a DID held in both places once, as config', async () => {
      const { app } = createCtx({
        adminUserStore: {
          list: vi.fn(async () => [
            { did: CONFIG_ADMIN, addedAt: '2026-02-02T00:00:00.000Z' },
          ]),
        },
      })

      const res = await invokeRoute(app, 'GET', LIST)

      const { admins } = res.body as { admins: Array<{ source: string }> }
      expect(admins).toHaveLength(1)
      expect(admins[0].source).toBe('config')
    })
  })

  describe('POST addAdmin', () => {
    it('rejects unauthenticated callers', async () => {
      const { app, adminUserStore } = createCtx({ adminAuthFails: true })

      const res = await invokeRoute(app, 'POST', ADD, { did: 'did:plc:new' })

      expect(res.statusCode).toBe(401)
      expect(adminUserStore.add).not.toHaveBeenCalled()
    })

    it('grants access and records who granted it', async () => {
      const { app, adminUserStore } = createCtx({})

      const res = await invokeRoute(app, 'POST', ADD, { did: 'did:plc:motoko' })

      expect(res.statusCode).toBe(200)
      expect(adminUserStore.add).toHaveBeenCalledWith('did:plc:motoko', VIEWER)
    })

    it('refuses a DID already granted through config', async () => {
      const { app, adminUserStore } = createCtx({})

      const res = await invokeRoute(app, 'POST', ADD, { did: CONFIG_ADMIN })

      expect(res.statusCode).toBe(400)
      expect(adminUserStore.add).not.toHaveBeenCalled()
    })

    it.each([[{}], [{ did: 'not-a-did' }], [{ did: 42 }], [{ did: '' }]])(
      'rejects a malformed body (%o)',
      async (body) => {
        const { app, adminUserStore } = createCtx({})

        const res = await invokeRoute(app, 'POST', ADD, body)

        expect(res.statusCode).toBe(400)
        expect(adminUserStore.add).not.toHaveBeenCalled()
      },
    )
  })

  describe('POST removeAdmin', () => {
    it('rejects unauthenticated callers', async () => {
      const { app, adminUserStore } = createCtx({ adminAuthFails: true })

      const res = await invokeRoute(app, 'POST', REMOVE, {
        did: 'did:plc:motoko',
      })

      expect(res.statusCode).toBe(401)
      expect(adminUserStore.remove).not.toHaveBeenCalled()
    })

    it('revokes a granted admin', async () => {
      const { app, adminUserStore } = createCtx({})

      const res = await invokeRoute(app, 'POST', REMOVE, {
        did: 'did:plc:motoko',
      })

      expect(res.statusCode).toBe(200)
      expect(adminUserStore.remove).toHaveBeenCalledWith('did:plc:motoko')
    })

    it('refuses to revoke a config admin, which would not take effect', async () => {
      const { app, adminUserStore } = createCtx({})

      const res = await invokeRoute(app, 'POST', REMOVE, { did: CONFIG_ADMIN })

      expect(res.statusCode).toBe(400)
      expect(adminUserStore.remove).not.toHaveBeenCalled()
    })

    it('refuses self-revocation so an operator cannot lock themselves out', async () => {
      const { app, adminUserStore } = createCtx({})

      const res = await invokeRoute(app, 'POST', REMOVE, { did: VIEWER })

      expect(res.statusCode).toBe(400)
      expect(adminUserStore.remove).not.toHaveBeenCalled()
    })

    it('returns 404 for a DID that holds no grant', async () => {
      const { app, adminUserStore } = createCtx({
        adminUserStore: { has: vi.fn(async () => false) },
      })

      const res = await invokeRoute(app, 'POST', REMOVE, {
        did: 'did:plc:stranger',
      })

      expect(res.statusCode).toBe(404)
      expect(adminUserStore.remove).not.toHaveBeenCalled()
    })

    it('reports a store failure as an internal error', async () => {
      const { app } = createCtx({
        adminUserStore: {
          remove: vi.fn(async () => {
            throw new Error('database is on fire')
          }),
        },
      })

      const res = await invokeRoute(app, 'POST', REMOVE, {
        did: 'did:plc:motoko',
      })

      expect(res.statusCode).toBe(500)
      expect((res.body as { error: string }).error).toBe('InternalError')
    })
  })
})
