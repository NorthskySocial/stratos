import { describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import type { Server as XrpcServer } from '@atproto/xrpc-server'
import type { AppContext } from '../src'
import { registerEnrollmentHandlers } from '../src/features'
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

interface HandlerContext {
  params: Record<string, unknown>
  auth?: unknown
}

interface HandlerResponse {
  encoding: string
  body: unknown
}

interface XrpcMethod {
  handler: (ctx: any) => Promise<HandlerResponse>
}

interface MockXrpcServer {
  methods: Record<string, XrpcMethod>
  method: (nsid: string, config: any) => void
}

function createMockXrpcServer(): MockXrpcServer {
  const methods: Record<string, XrpcMethod> = {}
  return {
    methods,
    method: (nsid: string, config: any) => {
      methods[nsid] = config
    },
  }
}

async function invokeMethod(
  server: MockXrpcServer,
  nsid: string,
  params: Record<string, unknown> = {},
  auth?: unknown,
  input?: { body: unknown },
): Promise<HandlerResponse> {
  const method = server.methods[nsid]
  if (!method) throw new Error(`Method ${nsid} not registered`)
  return method.handler({ params, auth, input })
}

function createCtx(opts: {
  getEnrollment: (did: string) => Promise<Enrollment | null>
  getBoundaries: (did: string) => Promise<string[]>
  authenticatedDid?: string | null
  createAttestation?: (
    did: string,
    boundaries: string[],
    userDidKey: string,
  ) => Promise<{ sig: Uint8Array; signingKey: string }>
}): AppContext {
  const createAttestation =
    opts.createAttestation ??
    (async () => ({
      sig: new Uint8Array([0xde, 0xad]),
      signingKey: 'did:key:zDnaeServiceKey',
    }))
  return {
    enrollmentService: {
      getEnrollment: opts.getEnrollment,
      isEnrolled: async (did: string) =>
        (await opts.getEnrollment(did)) !== null,
      enroll: vi.fn(),
      unenroll: vi.fn(),
    },
    boundaryResolver: { getBoundaries: opts.getBoundaries },
    authVerifier: {
      optionalStandard: vi.fn().mockResolvedValue({
        credentials: {
          type: opts.authenticatedDid ? 'dpop' : 'none',
          did: opts.authenticatedDid ?? undefined,
        },
      }),
      standard: vi.fn().mockImplementation(async () => {
        if (!opts.authenticatedDid) throw new Error('Auth required')
        return { credentials: { type: 'dpop', did: opts.authenticatedDid } }
      }),
    },
    createAttestation,
    app: {
      get: vi.fn(),
      post: vi.fn(),
      use: vi.fn(),
    } as any,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as AppContext
}

describe('Status endpoint with authentication', () => {
  it('returns enrolled status with boundaries when authenticated', async () => {
    await fc.assert(
      fc.asyncProperty(
        didArb(),
        boundarySetArb(),
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        async (did, boundaries, enrolledAt) => {
          const server = createMockXrpcServer()
          const ctx = createCtx({
            getEnrollment: async (queryDid) => {
              if (queryDid === did) {
                return {
                  did,
                  boundaries,
                  enrolledAt,
                  pdsEndpoint: 'https://pds.example.com',
                  signingKeyDid: 'did:key:zDnaeTestUser123',
                  active: true,
                }
              }
              return null
            },
            getBoundaries: async (queryDid) => {
              if (queryDid === did) return boundaries
              return []
            },
            authenticatedDid: did,
          })

          registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)
          const res = await invokeMethod(
            server,
            'zone.stratos.enrollment.status',
            { did },
            { credentials: { type: 'user', did } },
          )

          const body = res.body as Record<string, unknown>
          expect(body.did).toBe(did)
          expect(body.enrolled).toBe(true)
          expect(body.enrolledAt).toBe(enrolledAt.toISOString())

          // signingKey should be included when enrollment has one
          expect(body.signingKey).toBe('did:key:zDnaeTestUser123')

          // Boundaries should be included when authenticated
          const returnedBoundaries = body.boundaries as Array<{ value: string }>
          expect(returnedBoundaries).toBeDefined()
          expect(returnedBoundaries).toHaveLength(boundaries.length)

          const returnedValues = returnedBoundaries.map((b) => b.value).sort()
          expect(returnedValues).toEqual([...boundaries].sort())

          // Each boundary is a { value: string } Domain object
          for (const b of returnedBoundaries) {
            expect(Object.keys(b)).toEqual(['value'])
            expect(typeof b.value).toBe('string')
          }

          // Attestation should be present when authenticated with boundaries and signing key
          if (boundaries.length > 0) {
            const attestation = body.attestation as {
              sig: unknown
              signingKey: string
            }
            expect(attestation).toBeDefined()
            expect(attestation.signingKey).toBe('did:key:zDnaeServiceKey')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns enrolled status without boundaries when not authenticated', async () => {
    await fc.assert(
      fc.asyncProperty(
        didArb(),
        boundarySetArb(),
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        async (did, boundaries, enrolledAt) => {
          const server = createMockXrpcServer()
          const ctx = createCtx({
            getEnrollment: async (queryDid) => {
              if (queryDid === did) {
                return {
                  did,
                  boundaries,
                  enrolledAt,
                  pdsEndpoint: 'https://pds.example.com',
                  signingKeyDid: 'did:key:zDnaeTestUser123',
                  active: true,
                }
              }
              return null
            },
            getBoundaries: async () => [],
            authenticatedDid: null,
          })

          registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)
          const res = await invokeMethod(
            server,
            'zone.stratos.enrollment.status',
            { did },
            { credentials: { type: 'none' } },
          )

          const body = res.body as Record<string, unknown>
          expect(body.did).toBe(did)
          expect(body.enrolled).toBe(true)
          expect(body.enrolledAt).toBe(enrolledAt.toISOString())

          // signingKey should still be present even when unauthenticated
          expect(body.signingKey).toBe('did:key:zDnaeTestUser123')

          // Boundaries and attestation should NOT be included when not authenticated
          expect(body.boundaries).toBeUndefined()
          expect(body.attestation).toBeUndefined()
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('Status endpoint for non-enrolled DIDs', () => {
  it('returns enrolled: false with no boundaries or enrolledAt (unauthenticated)', async () => {
    await fc.assert(
      fc.asyncProperty(didArb(), async (did) => {
        const server = createMockXrpcServer()
        const ctx = createCtx({
          getEnrollment: async () => null,
          getBoundaries: async () => [],
          authenticatedDid: null,
        })

        registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)
        const res = await invokeMethod(
          server,
          'zone.stratos.enrollment.status',
          { did },
          { credentials: { type: 'none' } },
        )

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
  it('registers the route at zone.stratos.enrollment.status', () => {
    const server = createMockXrpcServer()
    const ctx = createCtx({
      getEnrollment: async () => null,
      getBoundaries: async () => [],
      authenticatedDid: null,
    })

    registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)

    expect(server.methods['zone.stratos.enrollment.status']).toBeDefined()
  })

  it('throws InvalidRequestError when did parameter is missing', async () => {
    const server = createMockXrpcServer()
    const ctx = createCtx({
      getEnrollment: async () => null,
      getBoundaries: async () => [],
      authenticatedDid: null,
    })

    registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)
    await expect(
      invokeMethod(server, 'zone.stratos.enrollment.status', {}),
    ).rejects.toThrow('did parameter required')
  })
})

describe('Unenroll endpoint', () => {
  it('successfully unenrolls a user', async () => {
    const did = 'did:plc:testuser'
    const server = createMockXrpcServer()

    const unenrollSpy = vi.fn().mockResolvedValue(undefined)
    const deleteRecordSpy = vi.fn().mockResolvedValue(undefined)
    const revokeSpy = vi.fn().mockResolvedValue(undefined)
    const getEnrollmentSpy = vi.fn().mockResolvedValue({
      did,
      enrollmentRkey: 'rkey-123',
    })

    const ctx = {
      enrollmentStore: {
        getEnrollment: getEnrollmentSpy,
      },
      enrollmentService: {
        unenroll: unenrollSpy,
      },
      profileRecordWriter: {
        deleteEnrollmentRecord: deleteRecordSpy,
      },
      oauthClient: {
        revoke: revokeSpy,
      },
      authVerifier: {
        standard: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      app: {
        get: vi.fn(),
        post: vi.fn(),
        use: vi.fn(),
      } as any,
    } as unknown as AppContext

    registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)

    const res = await invokeMethod(
      server,
      'zone.stratos.enrollment.unenroll',
      {},
      { credentials: { type: 'user', did } },
    )

    expect((res as any).body.success).toBe(true)
    expect(getEnrollmentSpy).toHaveBeenCalledWith(did)
    expect(deleteRecordSpy).toHaveBeenCalledWith(did, 'rkey-123')
    expect(unenrollSpy).toHaveBeenCalledWith(did)
    expect(revokeSpy).toHaveBeenCalledWith(did)
  })

  it('proceeds even if PDS record deletion fails', async () => {
    const did = 'did:plc:testuser'
    const server = createMockXrpcServer()

    const unenrollSpy = vi.fn().mockResolvedValue(undefined)
    const deleteRecordSpy = vi.fn().mockRejectedValue(new Error('PDS Error'))
    const revokeSpy = vi.fn().mockResolvedValue(undefined)
    const getEnrollmentSpy = vi.fn().mockResolvedValue({
      did,
      enrollmentRkey: 'rkey-123',
    })

    const ctx = {
      enrollmentStore: {
        getEnrollment: getEnrollmentSpy,
      },
      enrollmentService: {
        unenroll: unenrollSpy,
      },
      profileRecordWriter: {
        deleteEnrollmentRecord: deleteRecordSpy,
      },
      oauthClient: {
        revoke: revokeSpy,
      },
      authVerifier: {
        standard: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      app: {
        get: vi.fn(),
        post: vi.fn(),
        use: vi.fn(),
      } as any,
    } as unknown as AppContext

    registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)

    const res = await invokeMethod(
      server,
      'zone.stratos.enrollment.unenroll',
      {},
      { credentials: { type: 'user', did } },
    )

    expect((res as any).body.success).toBe(true)
    expect(getEnrollmentSpy).toHaveBeenCalledWith(did)
    expect(deleteRecordSpy).toHaveBeenCalledWith(did, 'rkey-123')
    expect(unenrollSpy).toHaveBeenCalledWith(did)
    expect(revokeSpy).toHaveBeenCalledWith(did)
  })

  it('proceeds even if OAuth revocation fails', async () => {
    const did = 'did:plc:testuser'
    const server = createMockXrpcServer()

    const unenrollSpy = vi.fn().mockResolvedValue(undefined)
    const deleteRecordSpy = vi.fn().mockResolvedValue(undefined)
    const revokeSpy = vi.fn().mockRejectedValue(new Error('OAuth Error'))
    const getEnrollmentSpy = vi.fn().mockResolvedValue({
      did,
      enrollmentRkey: 'rkey-123',
    })

    const ctx = {
      enrollmentStore: {
        getEnrollment: getEnrollmentSpy,
      },
      enrollmentService: {
        unenroll: unenrollSpy,
      },
      profileRecordWriter: {
        deleteEnrollmentRecord: deleteRecordSpy,
      },
      oauthClient: {
        revoke: revokeSpy,
      },
      authVerifier: {
        standard: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      app: {
        get: vi.fn(),
        post: vi.fn(),
        use: vi.fn(),
      } as any,
    } as unknown as AppContext

    registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)

    const res = await invokeMethod(
      server,
      'zone.stratos.enrollment.unenroll',
      {},
      { credentials: { type: 'user', did } },
    )

    expect((res as any).body.success).toBe(true)
    expect(getEnrollmentSpy).toHaveBeenCalledWith(did)
    expect(deleteRecordSpy).toHaveBeenCalledWith(did, 'rkey-123')
    expect(unenrollSpy).toHaveBeenCalledWith(did)
    expect(revokeSpy).toHaveBeenCalledWith(did)
  })

  it('requires authentication', async () => {
    const server = createMockXrpcServer()
    const ctx = {
      authVerifier: {
        standard: vi.fn(),
      },
      logger: {
        error: vi.fn(),
      },
      app: {
        get: vi.fn(),
        post: vi.fn(),
        use: vi.fn(),
      } as any,
    } as unknown as AppContext

    registerEnrollmentHandlers(server as unknown as XrpcServer, ctx)

    await expect(
      invokeMethod(server, 'zone.stratos.enrollment.unenroll', {}, undefined),
    ).rejects.toThrow()
  })
})
