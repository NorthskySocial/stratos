import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createOAuthRoutes } from '../src/oauth'
import { createMockEnrollment } from './utils'
// Extract mocks from the module
import * as atproto from '@atproto/api'

vi.mock('@atproto/api', () => {
  const mockPutRecord = vi.fn().mockResolvedValue({
    uri: 'at://did:plc:user/zone.stratos.actor.enrollment/rkey',
  })
  const mockListRecords = vi.fn().mockResolvedValue({ data: { records: [] } })

  return {
    Agent: class {
      com = {
        atproto: {
          repo: {
            putRecord: mockPutRecord,
            listRecords: mockListRecords,
          },
        },
      }
    },
    mockPutRecord,
    mockListRecords,
  }
})

const { mockPutRecord } = atproto as any

describe('Re-enrollment', () => {
  let mockEnrollmentStore: any
  let mockOauthClient: any
  let mockLogger: any
  let mockIdResolver: any
  let mockEnrollmentValidator: any

  const serviceDid = 'did:web:stratos.example.com'
  const serviceEndpoint = 'https://stratos.example.com'
  const userDid = 'did:plc:testuser'

  beforeEach(() => {
    vi.clearAllMocks()
    mockEnrollmentStore = {
      isEnrolled: vi.fn(),
      enroll: vi.fn(),
      getEnrollment: vi.fn(),
      getBoundaries: vi.fn(),
      updateEnrollment: vi.fn(),
      setBoundaries: vi.fn(),
    }
    mockOauthClient = {
      callback: vi.fn().mockResolvedValue({ session: { sub: userDid } }),
      restore: vi.fn().mockResolvedValue({}),
      revoke: vi.fn().mockResolvedValue(undefined),
    }
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    mockIdResolver = {
      resolve: vi.fn().mockResolvedValue({
        didDocument: {
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example.com',
            },
          ],
        },
      }),
    }
    mockEnrollmentValidator = {
      validate: vi.fn().mockResolvedValue({
        allowed: true,
        pdsEndpoint: 'https://pds.example.com',
      }),
    }
  })

  it('restores PDS record for an active user who deleted it', async () => {
    // 1. Setup: user is already active in Stratos
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue(
      createMockEnrollment(userDid, {
        signingKeyDid: 'did:key:user-key',
        active: true,
        enrollmentRkey: 'did:web:stratos.example.com', // serviceDIDToRkey('did:web:stratos.example.com')
      }),
    )
    mockEnrollmentStore.getBoundaries.mockResolvedValue(['engineering'])

    const config: any = {
      oauthClient: mockOauthClient,
      enrollmentConfig: { mode: 'open' },
      enrollmentStore: mockEnrollmentStore,
      enrollmentValidator: mockEnrollmentValidator,
      idResolver: mockIdResolver,
      baseUrl: 'https://stratos.example.com',
      serviceEndpoint: serviceEndpoint,
      serviceDid: serviceDid,
      logger: mockLogger,
      dpopVerifier: { verify: vi.fn().mockResolvedValue({ did: userDid }) },
      profileRecordWriter: {
        putEnrollmentRecord: mockPutRecord,
        deleteEnrollmentRecord: vi.fn(),
      },
      initRepo: vi.fn().mockResolvedValue(undefined),
      createSigningKey: vi.fn().mockResolvedValue('did:key:user-key'),
      createAttestation: vi.fn().mockResolvedValue({
        sig: new Uint8Array([1, 2, 3]),
        signingKey: 'did:key:service-key',
      }),
    }

    const router = createOAuthRoutes(config)
    const app = express()
    app.use(router)

    // Finding the handler in the router
    const handler = router.stack.find((s) => s.route?.path === '/callback')
      ?.route?.stack[0].handle as any

    const req: any = {
      url: '/callback?code=123&state=abc',
      method: 'GET',
      query: { code: '123', state: 'abc' },
      cookies: {},
    }
    const res: any = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    // 3. Verify: putEnrollmentRecord was called to restore the PDS record
    expect(mockPutRecord).toHaveBeenCalledWith(
      userDid,
      'did:web:stratos.example.com',
      expect.objectContaining({
        service: serviceEndpoint,
        signingKey: 'did:key:user-key',
      }),
    )

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: false,
        message: 'Already enrolled in Stratos',
      }),
    )
  })

  it('reactivates an inactive user', async () => {
    // 1. Setup: user is inactive
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false) // Inactive users return false for isEnrolled

    const config: any = {
      oauthClient: mockOauthClient,
      enrollmentConfig: { mode: 'open' },
      enrollmentStore: mockEnrollmentStore,
      enrollmentValidator: mockEnrollmentValidator,
      idResolver: mockIdResolver,
      baseUrl: 'https://stratos.example.com',
      serviceEndpoint: serviceEndpoint,
      serviceDid: serviceDid,
      logger: mockLogger,
      dpopVerifier: { verify: vi.fn().mockResolvedValue({ did: userDid }) },
      profileRecordWriter: {
        putEnrollmentRecord: mockPutRecord,
        deleteEnrollmentRecord: vi.fn(),
      },
      initRepo: vi.fn().mockResolvedValue(undefined),
      createSigningKey: vi.fn().mockResolvedValue('did:key:user-key'),
      createAttestation: vi.fn().mockResolvedValue({
        sig: new Uint8Array([1, 2, 3]),
        signingKey: 'did:key:service-key',
      }),
    }

    const router = createOAuthRoutes(config)
    const handler = router.stack.find((s) => s.route?.path === '/callback')
      ?.route?.stack[0].handle as any

    const req: any = {
      url: '/callback?code=123&state=abc',
      method: 'GET',
      query: { code: '123', state: 'abc' },
      cookies: {},
    }
    const res: any = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    // 2. Verify: enrollmentStore.enroll was called (which reactivates)
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        did: userDid,
        active: true,
      }),
    )

    // 3. Verify: putEnrollmentRecord was called
    expect(mockPutRecord).toHaveBeenCalledWith(
      userDid,
      'did:web:stratos.example.com',
      expect.objectContaining({
        service: serviceEndpoint,
        signingKey: 'did:key:user-key',
      }),
    )

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: true,
      }),
    )
  })
})
