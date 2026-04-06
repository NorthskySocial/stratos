import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext } from '../src'
import type { EnrollmentStore } from '../src/oauth'
import { registerEnrollmentHandlers } from '../src/features'

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

function createCtx(opts: {
  enrollmentStore?: Partial<EnrollmentStore>
  adminAuthFails?: boolean
}): {
  ctx: AppContext
  enrollmentStore: EnrollmentStore
  app: express.Application
} {
  const enrollmentStore = createMockStore(opts.enrollmentStore)

  const app = express()

  const ctx = {
    app,
    enrollmentStore,
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
    oauthClient: { restore: vi.fn(async () => ({})) },
    serviceDid: 'did:web:stratos.example.com',
    createAttestation: vi.fn(async () => ({
      sig: new Uint8Array([1, 2, 3]),
      signingKey: 'did:key:zTestKey',
    })),
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
  return { ctx, enrollmentStore, app }
}

describe('admin boundary endpoints', () => {
  vi.setConfig({ testTimeout: 15000 })
  describe('POST /xrpc/zone.stratos.admin.addBoundary', () => {
    it('adds a boundary to an enrolled user', async () => {
      const { app, enrollmentStore } = createCtx({})
      const res = await invokePostRoute(
        app,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'did:web:nerv.tokyo.jp/bees' },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as { did: string; boundaries: string[] }
      expect(body.did).toBe('did:plc:usagi')
      expect(body.boundaries).toBeDefined()
      expect(enrollmentStore.addBoundary).toHaveBeenCalledWith(
        'did:plc:usagi',
        'did:web:nerv.tokyo.jp/bees',
      )
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
      const body = res.body as { did: string; boundaries: string[] }
      expect(body.did).toBe('did:plc:usagi')
      expect(enrollmentStore.removeBoundary).toHaveBeenCalledWith(
        'did:plc:usagi',
        'did:web:nerv.tokyo.jp/posters-madness',
      )
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
      const body = res.body as { did: string; boundaries: string[] }
      expect(body.did).toBe('did:plc:usagi')
      expect(enrollmentStore.setBoundaries).toHaveBeenCalledWith(
        'did:plc:usagi',
        ['did:web:nerv.tokyo.jp/bees', 'did:web:nerv.tokyo.jp/plants'],
      )
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
})
