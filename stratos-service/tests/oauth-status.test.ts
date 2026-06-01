import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import { handleStatus } from '../src/oauth/handlers/status.js'
import type { EnrollmentStore, OAuthRoutesConfig } from '../src/oauth'

describe('handleStatus', () => {
  const mockEnrollmentStore = {
    getEnrollment: vi.fn(),
    getBoundaries: vi.fn(),
  } as unknown as EnrollmentStore

  const mockLogger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }

  const mockConfig = {
    enrollmentStore: mockEnrollmentStore,
    logger: mockLogger,
  } as unknown as OAuthRoutesConfig

  const createMocks = () => {
    vi.clearAllMocks()
    const req = {} as express.Request
    const res = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    } as unknown as express.Response
    const authenticateRequest = vi.fn()
    return { req, res, authenticateRequest }
  }

  it('returns enrolled status and boundaries for an enrolled user', async () => {
    const { req, res, authenticateRequest } = createMocks()
    const did = 'did:plc:gokusaiyan'
    const enrolledAt = '2023-01-01T00:00:00.000Z'
    const boundaries = ['capsule-corp.jp', 'mount-paozu.earth']

    authenticateRequest.mockResolvedValue(did)
    vi.mocked(mockEnrollmentStore.getEnrollment).mockResolvedValue({
      did,
      enrolledAt,
      active: true,
      signingKeyDid: 'did:key:zDnaeGoku',
    })
    vi.mocked(mockEnrollmentStore.getBoundaries).mockResolvedValue(boundaries)

    const handler = handleStatus(mockConfig, authenticateRequest)
    await handler(req, res)

    expect(authenticateRequest).toHaveBeenCalledWith(req, res)
    expect(mockEnrollmentStore.getEnrollment).toHaveBeenCalledWith(did)
    expect(mockEnrollmentStore.getBoundaries).toHaveBeenCalledWith(did)
    expect(res.json).toHaveBeenCalledWith({
      did,
      enrolled: true,
      enrolledAt,
      boundaries: [
        { value: 'capsule-corp.jp' },
        { value: 'mount-paozu.earth' },
      ],
    })
  })

  it('returns enrolled: false for a non-enrolled user', async () => {
    const { req, res, authenticateRequest } = createMocks()
    const did = 'did:plc:vegetaprince'

    authenticateRequest.mockResolvedValue(did)
    vi.mocked(mockEnrollmentStore.getEnrollment).mockResolvedValue(null)

    const handler = handleStatus(mockConfig, authenticateRequest)
    await handler(req, res)

    expect(res.json).toHaveBeenCalledWith({
      did,
      enrolled: false,
    })
    expect(mockEnrollmentStore.getBoundaries).not.toHaveBeenCalled()
  })

  it('returns early if authentication fails', async () => {
    const { req, res, authenticateRequest } = createMocks()

    authenticateRequest.mockResolvedValue(null)

    const handler = handleStatus(mockConfig, authenticateRequest)
    await handler(req, res)

    expect(res.json).not.toHaveBeenCalled()
    expect(mockEnrollmentStore.getEnrollment).not.toHaveBeenCalled()
  })

  it('returns 500 error if store throws', async () => {
    const { req, res, authenticateRequest } = createMocks()
    const did = 'did:plc:piccolo'
    const error = new Error('Database connection failed')

    authenticateRequest.mockResolvedValue(did)
    vi.mocked(mockEnrollmentStore.getEnrollment).mockRejectedValue(error)

    const handler = handleStatus(mockConfig, authenticateRequest)
    await handler(req, res)

    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: 'Database connection failed' },
      'status check failed',
    )
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: 'StatusError',
      message: 'Failed to check status',
    })
  })

  it('handles non-Error objects thrown', async () => {
    const { req, res, authenticateRequest } = createMocks()
    const did = 'did:plc:krillin'

    authenticateRequest.mockResolvedValue(did)
    vi.mocked(mockEnrollmentStore.getEnrollment).mockRejectedValue(
      'Something went wrong',
    )

    const handler = handleStatus(mockConfig, authenticateRequest)
    await handler(req, res)

    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: 'Something went wrong' },
      'status check failed',
    )
    expect(res.status).toHaveBeenCalledWith(500)
  })
})
