import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext, EnrollmentEventEmitter } from '../src'
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

function createCtx(opts: {
  enrollmentStore?: Partial<EnrollmentStore>
  adminAuthFails?: boolean
}): { app: express.Application; enrollmentStore: EnrollmentStore } {
  const enrollmentStore = {
    isEnrolled: vi.fn(async () => true),
    getEnrollment: vi.fn(async () => ({
      did: 'did:plc:usagi',
      enrolledAt: '2026-01-01T00:00:00.000Z',
      signingKeyDid: 'did:key:zSailorMoon',
      active: true,
    })),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    getBoundaries: vi.fn(async () => []),
    setBoundaries: vi.fn(async () => {}),
    addBoundary: vi.fn(async () => {}),
    removeBoundary: vi.fn(async () => {}),
    listEnrollments: vi.fn(async () => []),
    enrollmentCount: vi.fn(async () => 0),
    ...opts.enrollmentStore,
  } as unknown as EnrollmentStore

  const app = express()
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()

  const ctx = {
    app,
    enrollmentStore,
    enrollmentEvents,
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
        : vi.fn(async () => ({
            credentials: { type: 'admin', did: 'did:plc:haruki' },
          })),
      optionalStandard: vi.fn(async () => ({ credentials: { did: null } })),
    },
    serviceDid: 'did:web:nerv.tokyo.jp',
    cfg: {
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: {
        serviceDid: 'did:web:nerv.tokyo.jp',
        allowedDomains: ['did:web:nerv.tokyo.jp/general'],
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext

  registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
  return { app, enrollmentStore }
}

const ROUTE = '/xrpc/zone.stratos.admin.setActive'

describe('POST /xrpc/zone.stratos.admin.setActive', () => {
  it('rejects unauthenticated callers', async () => {
    const { app, enrollmentStore } = createCtx({ adminAuthFails: true })

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: false,
    })

    expect(res.statusCode).toBe(401)
    expect(enrollmentStore.updateEnrollment).not.toHaveBeenCalled()
  })

  it('deactivates an active member', async () => {
    const { app, enrollmentStore } = createCtx({})

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: false,
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ did: 'did:plc:usagi', active: false })
    expect(enrollmentStore.updateEnrollment).toHaveBeenCalledWith(
      'did:plc:usagi',
      { active: false },
    )
  })

  it('reactivates a deactivated member', async () => {
    const { app, enrollmentStore } = createCtx({
      enrollmentStore: {
        getEnrollment: vi.fn(async () => ({
          did: 'did:plc:usagi',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          signingKeyDid: 'did:key:zSailorMoon',
          active: false,
        })),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: true,
    })

    expect(res.statusCode).toBe(200)
    expect(enrollmentStore.updateEnrollment).toHaveBeenCalledWith(
      'did:plc:usagi',
      { active: true },
    )
  })

  it('is a no-op when the member is already in the requested state', async () => {
    const { app, enrollmentStore } = createCtx({})

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: true,
    })

    expect(res.statusCode).toBe(200)
    expect(enrollmentStore.updateEnrollment).not.toHaveBeenCalled()
  })

  it('returns 404 for a DID that is not enrolled', async () => {
    const { app, enrollmentStore } = createCtx({
      enrollmentStore: {
        getEnrollment: vi.fn(async () => null),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:nobody',
      active: false,
    })

    expect(res.statusCode).toBe(404)
    expect(enrollmentStore.updateEnrollment).not.toHaveBeenCalled()
  })

  it.each([
    [{ did: 'did:plc:usagi' }],
    [{ did: 'did:plc:usagi', active: 'false' }],
    [{ active: false }],
  ])('rejects a malformed body (%o)', async (body) => {
    const { app, enrollmentStore } = createCtx({})

    const res = await invokePostRoute(app, ROUTE, body)

    expect(res.statusCode).toBe(400)
    expect(enrollmentStore.updateEnrollment).not.toHaveBeenCalled()
  })

  it('reports a store failure as an internal error', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        updateEnrollment: vi.fn(async () => {
          throw new Error('database is on fire')
        }),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokePostRoute(app, ROUTE, {
      did: 'did:plc:usagi',
      active: false,
    })

    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('InternalError')
  })
})
