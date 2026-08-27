import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCallback } from '../src/oauth/handlers/callback.js'
import { buildSpaceScope } from '../src/oauth/index.js'

/**
 * A minimal OAuth session double. `scope` defaults to the base grant only,
 * i.e. a PDS that ignored the requested space scope — the common case for
 * tests unrelated to spaces-capability detection.
 */
function sessionFor(sub: string, scope = 'atproto') {
  return { sub, getTokenInfo: vi.fn().mockResolvedValue({ scope }) }
}

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
    const session = sessionFor('did:plc:alice')
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
    const session = sessionFor('did:plc:alice')
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
    const session = sessionFor('did:plc:malice')
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
    const session = sessionFor('did:plc:alice')
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

  it('redirects to the target that authorize verified into the OAuth state', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: 'https://app.example/',
    })
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

    expect(res.redirect).toHaveBeenCalledWith(
      'https://app.example/?stratos_enrolled=true',
    )
  })

  it('ignores a stratos_redirect cookie, which a host neighbour could forge', async () => {
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: null,
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'https://evil.example/' },
    }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await handler(req, res)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, did: 'did:plc:alice' }),
    )
    // With no stored target there is nothing to report. A guard that entered
    // the redirect branch anyway would warn here.
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  it('declines a stored redirect that uses a disallowed scheme', async () => {
    config.baseUrl = 'https://stratos.example'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:alice'),
      state: 'http://evil.example/',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'https://stratos.example/oauth/callback?code=foo&state=bar',
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
      session: sessionFor('did:plc:alice'),
      state: 'not-a-url',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
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
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did),
      state: 'https://app.example/',
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    const handler = handleCallback(config)
    const req: any = {
      url: 'http://localhost:3100/oauth/callback?code=secret-code&state=bar',
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

  it('handles re-enrollment logic correctly', async () => {
    // Test that handleExistingEnrollment is called and it updates/migrates as needed
    const session = sessionFor('did:plc:alice')
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

  describe('spaces capability detection', () => {
    // These tests need an unambiguous authority DID, so they override the
    // shared `did:web:localhost%3A3100` fixture with the house convention.
    const SERVICE_DID = 'did:web:stratos.example.com'

    beforeEach(() => {
      config.serviceDid = SERVICE_DID
      mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    })

    async function runCallback(session: unknown) {
      mockOauthClient.callback.mockResolvedValue({ session })
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
      return res
    }

    it('reports capable when the PDS granted the requested space scope', async () => {
      const scope = `atproto ${buildSpaceScope(SERVICE_DID)}`
      const session = sessionFor('did:plc:kenshin', scope)
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'capable' },
        'detected PDS spaces capability',
      )
      // getTokenInfo(true) would force a network refresh; the check only
      // needs the scope already on the session.
      expect(session.getTokenInfo).toHaveBeenCalledWith(false)
    })

    it('reports not-capable when the PDS silently dropped the space scope', async () => {
      // sessionFor defaults to the base-only grant, i.e. the scope a
      // non-spaces PDS returns after ignoring the space scope request.
      await runCallback(sessionFor('did:plc:kaoru'))

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kaoru', spacesCapability: 'not-capable' },
        'detected PDS spaces capability',
      )
    })

    it('reports not-capable when the granted scope names a different authority', async () => {
      const scope = `atproto ${buildSpaceScope('did:web:other.example.com')}`
      await runCallback(sessionFor('did:plc:sanosuke', scope))

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:sanosuke', spacesCapability: 'not-capable' },
        'detected PDS spaces capability',
      )
    })

    it('reports unknown, never not-capable, when the token-info read fails', async () => {
      const session = {
        sub: 'did:plc:megumi',
        getTokenInfo: vi
          .fn()
          .mockRejectedValue(new Error('introspection down')),
      }
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:megumi', spacesCapability: 'unknown' },
        'detected PDS spaces capability',
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ did: 'did:plc:megumi' }),
        expect.stringContaining('failed to read granted OAuth scope'),
      )
    })

    it('does not require a logger: a token-info failure still resolves the request', async () => {
      config.logger = undefined
      const session = {
        sub: 'did:plc:yahiko',
        getTokenInfo: vi
          .fn()
          .mockRejectedValue(new Error('introspection down')),
      }
      const res = await runCallback(session)

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, did: 'did:plc:yahiko' }),
      )
    })
  })
})
