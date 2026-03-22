import { describe, it, expect, vi } from 'vitest'
import express, { type Router } from 'express'
import type { AppContext } from '../src/context.js'
import type { EnrollmentStore } from '../src/oauth/routes.js'
import { registerEnrollmentHandlers } from '../src/features/enrollment/handler.js'

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokePostRoute(
  router: Router,
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

    type RouteLayer = {
      route?: {
        path: string
        stack: Array<{
          handle: (
            req: express.Request,
            res: express.Response,
            next: () => void,
          ) => unknown
        }>
      }
    }
    const layer = (router as unknown as { stack: RouteLayer[] }).stack.find(
      (l) => l.route?.path === path,
    )
    if (!layer?.route) return reject(new Error(`Route not registered: ${path}`))
    const handler = layer.route.stack[0]?.handle
    if (!handler) return reject(new Error('No handler on route'))

    Promise.resolve(handler(req, res, () => {})).catch(reject)
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
    getBoundaries: vi.fn(async () => ['posters-madness']),
    setBoundaries: vi.fn(async () => {}),
    addBoundary: vi.fn(async () => {}),
    removeBoundary: vi.fn(async () => {}),
    ...overrides,
  }
}

function createCtx(opts: {
  enrollmentStore?: Partial<EnrollmentStore>
  adminAuthFails?: boolean
}): { ctx: AppContext; enrollmentStore: EnrollmentStore; router: Router } {
  const enrollmentStore = createMockStore(opts.enrollmentStore)
  const router = express.Router()

  const ctx = {
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
      stratos: { allowedDomains: ['posters-madness', 'bees', 'plants'] },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as AppContext

  registerEnrollmentHandlers(router, ctx)
  return { ctx, enrollmentStore, router }
}

describe('admin boundary endpoints', () => {
  describe('POST /xrpc/zone.stratos.admin.addBoundary', () => {
    it('adds a boundary to an enrolled user', async () => {
      const { router, enrollmentStore } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'bees' },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as { did: string; boundaries: string[] }
      expect(body.did).toBe('did:plc:usagi')
      expect(body.boundaries).toBeDefined()
      expect(enrollmentStore.addBoundary).toHaveBeenCalledWith(
        'did:plc:usagi',
        'bees',
      )
    })

    it('rejects unauthenticated requests', async () => {
      const { router } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'bees' },
      )
      expect(res.statusCode).toBe(401)
    })

    it('rejects missing boundary field', async () => {
      const { router } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi' },
      )
      expect(res.statusCode).toBe(400)
      expect((res.body as { error: string }).error).toBe('InvalidRequest')
    })

    it('rejects boundaries not in allowed domains', async () => {
      const { router } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:usagi', boundary: 'forbidden-domain' },
      )
      expect(res.statusCode).toBe(400)
      expect((res.body as { message: string }).message).toContain(
        'not in allowed domains',
      )
    })

    it('returns 404 for unenrolled users', async () => {
      const { router } = createCtx({
        enrollmentStore: { isEnrolled: vi.fn(async () => false) },
      })
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.addBoundary',
        { did: 'did:plc:nobody', boundary: 'bees' },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /xrpc/zone.stratos.admin.removeBoundary', () => {
    it('removes a boundary from an enrolled user', async () => {
      const { router, enrollmentStore } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.removeBoundary',
        { did: 'did:plc:usagi', boundary: 'posters-madness' },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as { did: string; boundaries: string[] }
      expect(body.did).toBe('did:plc:usagi')
      expect(enrollmentStore.removeBoundary).toHaveBeenCalledWith(
        'did:plc:usagi',
        'posters-madness',
      )
    })

    it('rejects unauthenticated requests', async () => {
      const { router } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.removeBoundary',
        { did: 'did:plc:usagi', boundary: 'posters-madness' },
      )
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 for unenrolled users', async () => {
      const { router } = createCtx({
        enrollmentStore: { isEnrolled: vi.fn(async () => false) },
      })
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.removeBoundary',
        { did: 'did:plc:nobody', boundary: 'posters-madness' },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /xrpc/zone.stratos.admin.setBoundaries', () => {
    it('sets boundaries for an enrolled user', async () => {
      const { router, enrollmentStore } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi', boundaries: ['bees', 'plants'] },
      )
      expect(res.statusCode).toBe(200)
      const body = res.body as { did: string; boundaries: string[] }
      expect(body.did).toBe('did:plc:usagi')
      expect(enrollmentStore.setBoundaries).toHaveBeenCalledWith(
        'did:plc:usagi',
        ['bees', 'plants'],
      )
    })

    it('allows setting empty boundaries', async () => {
      const { router } = createCtx({
        enrollmentStore: { getBoundaries: vi.fn(async () => []) },
      })
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi', boundaries: [] },
      )
      expect(res.statusCode).toBe(200)
      expect((res.body as { boundaries: string[] }).boundaries).toEqual([])
    })

    it('rejects invalid boundaries', async () => {
      const { router } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi', boundaries: ['bees', 'not-allowed'] },
      )
      expect(res.statusCode).toBe(400)
      expect((res.body as { message: string }).message).toContain('not-allowed')
    })

    it('rejects missing boundaries array', async () => {
      const { router } = createCtx({})
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi' },
      )
      expect(res.statusCode).toBe(400)
    })

    it('rejects unauthenticated requests', async () => {
      const { router } = createCtx({ adminAuthFails: true })
      const res = await invokePostRoute(
        router,
        '/xrpc/zone.stratos.admin.setBoundaries',
        { did: 'did:plc:usagi', boundaries: ['bees'] },
      )
      expect(res.statusCode).toBe(401)
    })
  })
})
