import { describe, expect, it } from 'vitest'
import express from 'express'
import { registerEnrollmentHandlers } from '../src/features/index.js'
import type { AppContext } from '../src/index.js'
import { EnrollmentDeniedError } from '@northskysocial/stratos-core'

interface MockXrpcServer {
  methods: Record<string, any>
  method: (nsid: string, config: any) => void
}

function createMockXrpcServer(): MockXrpcServer {
  const methods: Record<string, any> = {}
  return {
    methods,
    method: (nsid: string, config: any) => {
      // The registerEnrollmentHandlers function calls server.method(nsid, config)
      // where config is { auth, handler }
      methods[nsid] = config.handler
    },
  }
}

async function invokeMethod(
  server: MockXrpcServer,
  nsid: string,
  params: Record<string, unknown> = {},
  auth?: unknown,
): Promise<any> {
  const handler = server.methods[nsid]
  if (!handler) throw new Error(`Method ${nsid} not registered`)
  // The handler returned by createXrpcHandler is (handlerCtx) => Promise<HandlerResponse>
  const result = await handler({ params, auth })
  return { statusCode: 200, body: result.body }
}

function createCtx(opts: {
  getEnrollment: (did: string) => Promise<any | null>
  isEligible?: boolean
}): AppContext {
  const app = express()
  ;(app as any)._router = (app as any)._router || express.Router()
  return {
    enrollmentService: {
      getEnrollment: opts.getEnrollment,
      isEnrolled: async (did: string) =>
        (await opts.getEnrollment(did)) !== null,
    },
    enrollmentStore: {
      getEnrollment: opts.getEnrollment,
    },
    boundaryResolver: {
      getBoundaries: async () => [],
    },
    authVerifier: {
      optionalStandard: async () => ({ credentials: { type: 'none' } }),
      standard: async () => {
        throw new Error('Unauthorized')
      },
    },
    cfg: {
      enrollment: {
        mode: opts.isEligible ? 'open' : 'closed',
        allowedPdsEndpoints: [],
        autoEnrollDomains: ['example.com'],
      },
      stratos: {
        mode: 'open',
        allowedDomains: ['example.com'],
      },
    },
    idResolver: {
      did: {
        resolve: async () =>
          opts.isEligible
            ? {
                service: [
                  {
                    id: '#atproto_pds',
                    serviceEndpoint: 'https://pds.example.com',
                  },
                ],
              }
            : null,
      },
    } as any,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any,
    app,
  } as unknown as AppContext
}

describe('Enrollment status eligibility', () => {
  it('reports enrolled: false and eligible: false when user not in DB and not eligible', async () => {
    const xrpc = createMockXrpcServer()
    const ctx = createCtx({
      getEnrollment: async () => null,
      isEligible: false,
    })

    registerEnrollmentHandlers(xrpc as any, ctx)
    const res = await invokeMethod(xrpc, 'zone.stratos.enrollment.status', {
      did: 'did:plc:shinji-tokyo3',
    })

    expect(res.body.enrolled).toBe(false)
    expect(res.body.eligible).toBe(false)
  })

  it('reports enrolled: false and eligible: true when user not in DB but is eligible', async () => {
    const xrpc = createMockXrpcServer()
    const ctx = createCtx({
      getEnrollment: async () => null,
      isEligible: true,
    })

    registerEnrollmentHandlers(xrpc as any, ctx)
    const res = await invokeMethod(xrpc, 'zone.stratos.enrollment.status', {
      did: 'did:plc:asuka-nerv',
    })

    // Eligibility must not be reported as enrollment: an eligible DID has no
    // enrollment row, cannot write records, and has no PDS enrollment record.
    expect(res.body.enrolled).toBe(false)
    expect(res.body.eligible).toBe(true)
  })

  it('reports enrolled: true with active: false for a deactivated enrollment row', async () => {
    const xrpc = createMockXrpcServer()
    const enrolledAt = new Date('2026-01-15T12:00:00.000Z')
    const ctx = createCtx({
      getEnrollment: async () => ({
        did: 'did:plc:rei-nerv',
        enrolledAt,
        active: false,
        signingKeyDid: 'did:key:zRei',
        enrollmentRkey: 'rkey-rei',
      }),
      isEligible: true,
    })

    registerEnrollmentHandlers(xrpc as any, ctx)
    const res = await invokeMethod(xrpc, 'zone.stratos.enrollment.status', {
      did: 'did:plc:rei-nerv',
    })

    // Deactivated is not the same as not enrolled: the row exists.
    expect(res.body.enrolled).toBe(true)
    expect(res.body.active).toBe(false)
    expect(res.body.eligible).toBeUndefined()
    expect(res.body.enrolledAt).toBe(enrolledAt.toISOString())
    expect(res.body.enrollmentRkey).toBe('rkey-rei')
  })
})
