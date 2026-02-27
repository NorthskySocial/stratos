import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import express, { type Router } from 'express'
import type { AppContext } from '../src/context.js'
import { registerEnrollmentHandlers } from '../src/features/enrollment/handler.js'
import type { Enrollment } from '@northskysocial/stratos-core'

function didArb(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[a-z2-7]{24}$/).map((s) => `did:plc:${s}`)
}

function boundaryArb(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[a-z0-9]{3,20}$/).map((s) => `${s}.example.com`)
}

function boundarySetArb(): fc.Arbitrary<string[]> {
  return fc.uniqueArray(boundaryArb(), { minLength: 0, maxLength: 10 })
}

interface MockResponse {
  statusCode: number
  body: unknown
}

function invokeRoute(
  router: Router,
  query: Record<string, string>,
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const req = { query } as unknown as express.Request
    const res = {
      status(code: number) {
        statusCode = code
        return res
      },
      json(body: unknown) {
        resolve({ statusCode, body })
        return res
      },
    } as unknown as express.Response

    // Extract the registered route handler from the router stack
    type RouteLayer = {
      route?: {
        path: string
        stack: Array<{ handle: Function }>
      }
    }
    const layer = (router as unknown as { stack: RouteLayer[] }).stack.find(
      (l) => l.route?.path === '/xrpc/app.stratos.enrollment.status',
    )
    if (!layer?.route) return reject(new Error('Route not registered'))
    const handler = layer.route.stack[0]?.handle
    if (!handler) return reject(new Error('No handler on route'))

    Promise.resolve(handler(req, res, () => {})).catch(reject)
  })
}

function createCtx(opts: {
  getEnrollment: (did: string) => Promise<Enrollment | null>
  getBoundaries: (did: string) => Promise<string[]>
}): AppContext {
  return {
    enrollmentService: { getEnrollment: opts.getEnrollment },
    enrollmentStore: { getBoundaries: opts.getBoundaries },
    logger: undefined,
  } as unknown as AppContext
}


describe('Status endpoint returns authoritative boundaries for enrolled DIDs', () => {
  it('returns enrolled status with authoritative boundaries as Domain objects', async () => {
    await fc.assert(
      fc.asyncProperty(
        didArb(),
        boundarySetArb(),
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-01-01T00:00:00Z'), noInvalidDate: true }),
        async (did, boundaries, enrolledAt) => {
          const router = express.Router()
          const ctx = createCtx({
            getEnrollment: async (queryDid) => {
              if (queryDid === did) {
                return { did, boundaries, enrolledAt, pdsEndpoint: 'https://pds.example.com' }
              }
              return null
            },
            getBoundaries: async (queryDid) => {
              if (queryDid === did) return boundaries
              return []
            },
          })

          registerEnrollmentHandlers(router, ctx)
          const res = await invokeRoute(router, { did })

          expect(res.statusCode).toBe(200)

          const body = res.body as Record<string, unknown>
          expect(body.did).toBe(did)
          expect(body.enrolled).toBe(true)
          expect(body.enrolledAt).toBe(enrolledAt.toISOString())

          const returnedBoundaries = body.boundaries as Array<{ value: string }>
          expect(returnedBoundaries).toHaveLength(boundaries.length)

          const returnedValues = returnedBoundaries.map((b) => b.value).sort()
          expect(returnedValues).toEqual([...boundaries].sort())

          // Each boundary is a { value: string } Domain object
          for (const b of returnedBoundaries) {
            expect(Object.keys(b)).toEqual(['value'])
            expect(typeof b.value).toBe('string')
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('Status endpoint returns no boundaries for non-enrolled DIDs', () => {
  it('returns enrolled: false with no boundaries or enrolledAt', async () => {
    await fc.assert(
      fc.asyncProperty(didArb(), async (did) => {
        const router = express.Router()
        const ctx = createCtx({
          getEnrollment: async () => null,
          getBoundaries: async () => [],
        })

        registerEnrollmentHandlers(router, ctx)
        const res = await invokeRoute(router, { did })

        expect(res.statusCode).toBe(200)

        const body = res.body as Record<string, unknown>
        expect(body.did).toBe(did)
        expect(body.enrolled).toBe(false)
        expect(body).not.toHaveProperty('boundaries')
        expect(body).not.toHaveProperty('enrolledAt')
      }),
      { numRuns: 100 },
    )
  })
})

describe('Status endpoint route registration', () => {
  it('registers the route at /xrpc/app.stratos.enrollment.status', () => {
    const router = express.Router()
    const ctx = createCtx({
      getEnrollment: async () => null,
      getBoundaries: async () => [],
    })

    registerEnrollmentHandlers(router, ctx)

    type RouteLayer = {
      route?: { path: string; methods: Record<string, boolean> }
    }
    const layers = (router as unknown as { stack: RouteLayer[] }).stack
    const statusRoute = layers.find(
      (l) => l.route?.path === '/xrpc/app.stratos.enrollment.status',
    )

    expect(statusRoute).toBeDefined()
    expect(statusRoute!.route!.methods.get).toBe(true)
  })

  it('returns 400 when did parameter is missing', async () => {
    const router = express.Router()
    const ctx = createCtx({
      getEnrollment: async () => null,
      getBoundaries: async () => [],
    })

    registerEnrollmentHandlers(router, ctx)
    const res = await invokeRoute(router, {})

    expect(res.statusCode).toBe(400)
    const body = res.body as Record<string, unknown>
    expect(body.error).toBe('InvalidRequest')
  })
})
