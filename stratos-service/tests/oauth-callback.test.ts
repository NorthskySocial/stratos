import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCallback } from '../src/oauth/handlers/callback.js'

describe('handleCallback', () => {
  let mockOauthClient: any
  let mockEnrollmentStore: any
  let mockIdResolver: any
  let mockProfileRecordWriter: any
  let mockLogger: any
  let mockEnrollmentConfig: any
  let mockEnrollmentValidator: any
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
    }
    mockIdResolver = {
      did: {
        resolve: vi.fn(),
      },
    }
    mockEnrollmentValidator = {
      validate: vi.fn().mockResolvedValue({ allowed: true }),
    }
    mockProfileRecordWriter = {
      putEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
      deleteEnrollmentRecord: vi.fn().mockResolvedValue(undefined),
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
      idResolver: mockIdResolver,
      enrollmentConfig: mockEnrollmentConfig,
      enrollmentValidator: mockEnrollmentValidator,
      profileRecordWriter: mockProfileRecordWriter,
      logger: mockLogger,
      baseUrl: 'http://localhost:3100',
      allowedRedirectOrigins: [],
      serviceEndpoint: 'http://localhost:3100',
      serviceDid: 'did:web:localhost%3A3100',
      initRepo: vi.fn(),
      createSigningKey: vi.fn().mockResolvedValue('did:key:zQ3sh...'),
      createAttestation: vi.fn().mockResolvedValue({
        sig: new Uint8Array(),
        signingKey: 'did:key:zQ3sh...',
      }),
    }
  })

  it('handles successful new enrollment', async () => {
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

    expect(mockOauthClient.callback).toHaveBeenCalled()
    expect(mockEnrollmentStore.enroll).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: true,
        did: 'did:plc:alice',
      }),
    )
  })

  it('handles successful existing enrollment', async () => {
    const session = { sub: 'did:plc:alice' }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did: 'did:plc:alice',
      enrollmentRkey: 'did:web:localhost:3100',
    })

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

    expect(mockOauthClient.callback).toHaveBeenCalled()
    expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: false,
        did: 'did:plc:alice',
        message: 'Already enrolled in Stratos',
      }),
    )
  })

  it('denies enrollment if not allowed', async () => {
    const session = { sub: 'did:plc:malice' }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: false,
      reason: 'NotInAllowlist',
    })

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(mockOauthClient.revoke).toHaveBeenCalledWith('did:plc:malice')
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EnrollmentDenied',
        message: 'Your account is not eligible for this Stratos service',
      }),
    )
  })

  it('handles OAuth callback failure', async () => {
    mockOauthClient.callback.mockRejectedValue(new Error('OAuth failed'))

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CallbackError',
        message: 'Failed to complete authorization',
      }),
    )
  })

  it('handles DID resolution failure when checking PDS allowlist', async () => {
    const session = { sub: 'did:plc:alice' }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: false,
      reason: 'DidNotResolved',
    })

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EnrollmentDenied',
        message: 'Could not verify your identity',
      }),
    )
  })

  it('redirects to the stored target that authorize already verified', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: { sub: 'did:plc:alice' },
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'https://app.example/' },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example/?stratos_enrolled=true',
    )
    expect(res.clearCookie).toHaveBeenCalledWith('stratos_redirect')
  })

  it('declines a stored redirect that uses a disallowed scheme', async () => {
    config.baseUrl = 'https://stratos.example'
    mockOauthClient.callback.mockResolvedValue({
      session: { sub: 'did:plc:alice' },
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'https://stratos.example/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'http://evil.example/' },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { origin: 'http://evil.example' },
      expect.stringContaining('disallowed scheme'),
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, did: 'did:plc:alice' }),
    )
  })

  it('declines a stored redirect that is not a valid URL', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: { sub: 'did:plc:alice' },
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'not-a-url' },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining('not a valid URL'),
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    )
  })

  it('puts no credential on the redirect', async () => {
    const did = 'did:plc:alice'
    mockOauthClient.callback.mockResolvedValue({ session: { sub: did } })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=secret-code&state=bar',
      cookies: { stratos_redirect: 'https://app.example/' },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    const target = new URL(res.redirect.mock.calls[0][0])
    expect([...target.searchParams.keys()]).toEqual(['stratos_enrolled'])
    expect(target.href).not.toContain(did)
    expect(target.href).not.toContain('secret-code')
    expect(target.hash).toBe('')
  })

  it('redirects to an allow-listed origin with the enrolled flag', async () => {
    config.allowedRedirectOrigins = ['https://app.example']
    mockOauthClient.callback.mockResolvedValue({
      session: { sub: 'did:plc:alice' },
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'https://app.example/' },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example/?stratos_enrolled=true',
    )
    expect(res.json).not.toHaveBeenCalled()
  })

  it('returns JSON when the request carries a null cookie jar', async () => {
    config.allowedRedirectOrigins = ['https://app.example']
    mockOauthClient.callback.mockResolvedValue({
      session: { sub: 'did:plc:spike' },
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: null,
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, did: 'did:plc:spike' }),
    )
  })

  it('ignores a redirect cookie that is not a string', async () => {
    config.allowedRedirectOrigins = ['https://app.example']
    mockOauthClient.callback.mockResolvedValue({
      session: { sub: 'did:plc:faye' },
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: {
        stratos_redirect: ['https://app.example/', 'https://app.example/two'],
      },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.clearCookie).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, did: 'did:plc:faye' }),
    )
  })

  it('handles re-enrollment logic correctly', async () => {
    // Test that handleExistingEnrollment is called and it updates/migrates as needed
    const session = { sub: 'did:plc:alice' }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
    mockEnrollmentStore.getEnrollment.mockResolvedValue({
      did: 'did:plc:alice',
      enrollmentRkey: 'old-rkey', // Trigger migration
    })

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

    // Should still return success
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: false,
      }),
    )
  })
})
