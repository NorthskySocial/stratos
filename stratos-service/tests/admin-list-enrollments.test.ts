import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AppContext, EnrollmentEventEmitter } from '../src'
import type { EnrollmentStore } from '../src/oauth'
import { registerEnrollmentHandlers } from '../src/features'

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokeGetRoute(
  app: express.Application,
  path: string,
  query: Record<string, unknown> = {},
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = {
      query,
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

    app(req, res, (err?: unknown) => {
      if (err) return reject(err)
      resolve({ statusCode, body: null })
    })
  })
}

const NERV = 'did:web:nerv.tokyo.jp'

function storedEnrollment(
  did: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    did,
    enrolledAt: '2026-01-01T00:00:00.000Z',
    pdsEndpoint: 'https://pds.example.com',
    signingKeyDid: 'did:key:zSailorMoon',
    active: true,
    isService: false,
    ...overrides,
  }
}

function createCtx(opts: {
  enrollmentStore?: Partial<EnrollmentStore>
  adminAuthFails?: boolean
}): { app: express.Application; enrollmentStore: EnrollmentStore } {
  const enrollmentStore = {
    isEnrolled: vi.fn(async () => true),
    getEnrollment: vi.fn(),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    getBoundaries: vi.fn(async () => [`${NERV}/general`]),
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
    serviceDid: NERV,
    cfg: {
      service: { publicUrl: 'https://stratos.example.com' },
      stratos: { serviceDid: NERV, allowedDomains: [`${NERV}/general`] },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as AppContext

  registerEnrollmentHandlers({ method: vi.fn() } as never, ctx)
  return { app, enrollmentStore }
}

const ROUTE = '/xrpc/zone.stratos.admin.listEnrollments'

describe('GET /xrpc/zone.stratos.admin.listEnrollments', () => {
  it('rejects unauthenticated callers', async () => {
    const { app, enrollmentStore } = createCtx({ adminAuthFails: true })

    const res = await invokeGetRoute(app, ROUTE)

    expect(res.statusCode).toBe(401)
    expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
  })

  it('returns enrollments with their boundaries', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments: vi.fn(async () => [
          storedEnrollment('did:plc:usagi'),
          storedEnrollment('did:plc:motoko', { isService: true }),
        ]),
        getBoundaries: vi.fn(async (did: string) =>
          did === 'did:plc:usagi'
            ? [`${NERV}/general`, `${NERV}/swordsmith`]
            : [`${NERV}/general`],
        ),
        enrollmentCount: vi.fn(async () => 2),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      enrollments: [
        {
          did: 'did:plc:usagi',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          active: true,
          isService: false,
          boundaries: [`${NERV}/general`, `${NERV}/swordsmith`],
        },
        {
          did: 'did:plc:motoko',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          active: true,
          isService: true,
          boundaries: [`${NERV}/general`],
        },
      ],
      cursor: undefined,
      total: 2,
    })
  })

  it('defaults to a limit of 50 and passes the cursor through', async () => {
    const listEnrollments = vi.fn(async () => [])
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments,
      } as unknown as Partial<EnrollmentStore>,
    })

    await invokeGetRoute(app, ROUTE, { cursor: 'did:plc:asuka' })

    // Over-fetches by one to detect whether another page exists.
    expect(listEnrollments).toHaveBeenCalledWith({
      limit: 51,
      cursor: 'did:plc:asuka',
    })
  })

  it('returns a cursor only when another page exists', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        // Three rows for a limit of 2: the extra row signals a next page.
        listEnrollments: vi.fn(async () => [
          storedEnrollment('did:plc:rei'),
          storedEnrollment('did:plc:shinji'),
          storedEnrollment('did:plc:asuka'),
        ]),
        enrollmentCount: vi.fn(async () => 5),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE, { limit: '2' })
    const body = res.body as { enrollments: unknown[]; cursor?: string }
    expect(body.enrollments).toHaveLength(2)
    expect(body.cursor).toBe('did:plc:shinji')
  })

  it('omits the cursor on a final page that exactly fills the limit', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments: vi.fn(async () => [
          storedEnrollment('did:plc:rei'),
          storedEnrollment('did:plc:shinji'),
        ]),
        enrollmentCount: vi.fn(async () => 2),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE, { limit: '2' })
    const body = res.body as { enrollments: unknown[]; cursor?: string }
    expect(body.enrollments).toHaveLength(2)
    expect(body.cursor).toBeUndefined()
  })

  it.each([['0'], ['101'], ['abc'], ['1.5']])(
    'rejects an out-of-range limit (%s)',
    async (limit) => {
      const { app, enrollmentStore } = createCtx({})

      const res = await invokeGetRoute(app, ROUTE, { limit })

      expect(res.statusCode).toBe(400)
      expect(enrollmentStore.listEnrollments).not.toHaveBeenCalled()
    },
  )

  it('reports a store failure as an internal error', async () => {
    const { app } = createCtx({
      enrollmentStore: {
        listEnrollments: vi.fn(async () => {
          throw new Error('database is on fire')
        }),
      } as unknown as Partial<EnrollmentStore>,
    })

    const res = await invokeGetRoute(app, ROUTE)

    expect(res.statusCode).toBe(500)
    expect((res.body as { error: string }).error).toBe('InternalError')
  })
})
