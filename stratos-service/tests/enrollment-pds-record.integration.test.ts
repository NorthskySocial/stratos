import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCallback } from '../src/oauth/handlers/callback.js'

describe('handleCallback PDS Record', () => {
  let mockOauthClient: any
  let mockEnrollmentStore: any
  let mockIdResolver: any
  let mockProfileRecordWriter: any
  let mockLogger: any
  let mockEnrollmentConfig: any
  let config: any

  beforeEach(() => {
    mockOauthClient = {
      callback: vi.fn(),
      revoke: vi.fn(),
    }
    mockEnrollmentStore = {
      isEnrolled: vi.fn(),
      enroll: vi.fn(),
      getEnrollment: vi.fn(),
      getBoundaries: vi.fn(),
      setBoundaries: vi.fn(),
    }
    const mockEnrollmentValidator = {
      validate: vi
        .fn()
        .mockResolvedValue({ allowed: true, pdsEndpoint: 'https://pds.test' }),
    }
    mockIdResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          alsoKnownAs: ['at://alice.test'],
          verificationMethod: [],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.test',
            },
          ],
        }),
      },
    }
    mockProfileRecordWriter = {
      putEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
    }
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    mockEnrollmentConfig = {
      mode: 'open',
    }
    config = {
      oauthClient: mockOauthClient,
      enrollmentStore: mockEnrollmentStore,
      enrollmentValidator: mockEnrollmentValidator,
      idResolver: mockIdResolver,
      enrollmentConfig: mockEnrollmentConfig,
      profileRecordWriter: mockProfileRecordWriter,
      logger: mockLogger,
      baseUrl: 'http://localhost:3100',
      serviceEndpoint: 'http://localhost:3100',
      serviceDid: 'did:web:localhost%3A3100',
      initRepo: vi.fn().mockResolvedValue(undefined),
      createSigningKey: vi.fn().mockResolvedValue('did:key:zQ3sh...'),
      createAttestation: vi.fn().mockResolvedValue({
        sig: new Uint8Array(),
        signingKey: 'did:key:zQ3sh...',
      }),
    }
  })

  it('calls putEnrollmentRecord on new enrollment', async () => {
    const session = { sub: 'did:plc:alice' }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    }

    await handler(req, res)

    expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
      'did:plc:alice',
      expect.any(String),
      expect.objectContaining({
        service: 'http://localhost:3100',
        signingKey: 'did:key:zQ3sh...',
      }),
    )
  })

  it('calls putEnrollmentRecord on existing enrollment to ensure it exists', async () => {
    const session = { sub: 'did:plc:alice' }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did: 'did:plc:alice',
      active: true,
      enrollmentRkey: 'localhost-3100',
      signingKeyDid: 'did:key:zQ3sh...',
    })
    mockEnrollmentStore.getBoundaries.mockResolvedValue(['engineering'])

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    }

    await handler(req, res)

    expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
      'did:plc:alice',
      'localhost-3100',
      expect.objectContaining({
        service: 'http://localhost:3100',
      }),
    )
  })
})
