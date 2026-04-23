import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRevoke } from '../src/oauth/handlers/revoke.js'

describe('OAuth Revoke Handler', () => {
  const mockEnrollmentStore = {
    getEnrollment: vi.fn(),
    unenroll: vi.fn(),
  }

  const mockOauthClient = {
    restore: vi.fn(),
    revoke: vi.fn(),
  }

  const mockLogger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }

  const config = {
    oauthClient: mockOauthClient as any,
    enrollmentStore: mockEnrollmentStore as any,
    serviceDid: 'did:web:stratos.actor',
    logger: mockLogger as any,
    initRepo: vi.fn(),
    createSigningKey: vi.fn(),
    createAttestation: vi.fn(),
  }

  const authenticateRequest = vi.fn()
  const handler = handleRevoke(config as any, authenticateRequest)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should successfully revoke enrollment', async () => {
    const did = 'did:plc:user1'
    authenticateRequest.mockResolvedValue(did)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did,
      enrollmentRkey: 'rkey1',
    })
    mockOauthClient.restore.mockResolvedValue({})
    // Agent deleteRecord mock would be complex, but we mainly want to see it called

    const req = {} as any
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any

    await handler(req, res)

    expect(mockEnrollmentStore.unenroll).toHaveBeenCalledWith(did)
    expect(mockOauthClient.revoke).toHaveBeenCalledWith(did)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        revoked: true,
        did,
      }),
    )
  })

  it('should return 404 if user not enrolled', async () => {
    const did = 'did:plc:user1'
    authenticateRequest.mockResolvedValue(did)
    mockEnrollmentStore.getEnrollment.mockResolvedValue(null)

    const req = {} as any
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'NotFound',
      }),
    )
  })

  it('should handle OAuth revocation failure gracefully', async () => {
    const did = 'did:plc:user1'
    authenticateRequest.mockResolvedValue(did)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({ did })
    mockOauthClient.revoke.mockRejectedValue(new Error('revoke failed'))

    const req = {} as any
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any

    await handler(req, res)

    expect(mockEnrollmentStore.unenroll).toHaveBeenCalledWith(did)
    expect(mockLogger.warn).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        revoked: true,
      }),
    )
  })
})
