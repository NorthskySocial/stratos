import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import { handleCallback } from '../src/oauth/handlers/callback.js'
import { buildSpaceScope } from '../src/oauth/index.js'

/** Minimal Express request the callback handler reads. */
interface MockRequest {
  url: string
  cookies?: Record<string, string>
  headers?: Record<string, string>
}

/** Minimal Express response the callback handler writes. */
interface MockResponse {
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
  // Not every case exercises the redirect or cookie branches.
  redirect?: ReturnType<typeof vi.fn>
  clearCookie?: ReturnType<typeof vi.fn>
}

function makeReq(
  url = 'http://localhost:3100/oauth/callback?code=foo&state=bar',
): MockRequest {
  return { url }
}

function makeRes(): MockResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    redirect: vi.fn(),
  }
}

/**
 * The handler wants Express types; these mocks carry only what it touches.
 * The cast is confined here so no test needs `any` at the call site.
 */
function callHandler(
  handler: ReturnType<typeof handleCallback>,
  req: MockRequest,
  res: MockResponse,
): Promise<unknown> {
  const invoke = handler as unknown as (
    req: MockRequest,
    res: MockResponse,
  ) => unknown
  return Promise.resolve(invoke(req, res))
}

/**
 * A minimal OAuth session double. `scope` defaults to the base grant only,
 * i.e. a PDS that ignored the requested space scope — the common case for
 * tests unrelated to spaces-capability detection.
 */
function sessionFor(sub: string, scope = 'atproto') {
  return { sub, getTokenInfo: vi.fn().mockResolvedValue({ scope }) }
}

/** A DID document exposing `keypair` as the DID's `#atproto` signing method. */
function atprotoDidDoc(did: string, keypair: Keypair) {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example.com',
      },
    ],
  }
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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

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

  it('records the spaces capability verdict for a new enrollment', async () => {
    const session = sessionFor(
      'did:plc:alice',
      `atproto ${buildSpaceScope(config.serviceDid)}`,
    )
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://spaces.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue(
      atprotoDidDoc('did:plc:alice', keypair),
    )

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

    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        did: 'did:plc:alice',
        spacesCapability: 'capable',
        custody: 'pds',
      },
      'determined enrollment custody',
    )
  })

  it('keeps stratos custody end-to-end when the capability verdict is not-capable', async () => {
    const session = sessionFor('did:plc:kenshin')
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
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

    expect(config.initRepo).toHaveBeenCalledWith('did:plc:kenshin')
    expect(config.createSigningKey).toHaveBeenCalledWith('did:plc:kenshin')
    expect(mockIdResolver.did.resolve).not.toHaveBeenCalled()
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        did: 'did:plc:kenshin',
        signingKeyDid: 'did:key:zQ3sh...',
        custody: 'stratos',
        repoHost: undefined,
      }),
    )
    expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
      'did:plc:kenshin',
      expect.any(String),
      expect.objectContaining({ custody: 'stratos', repoHost: undefined }),
    )
  })

  it('falls back to stratos custody when the capability verdict is unknown', async () => {
    const session = {
      sub: 'did:plc:rei',
      getTokenInfo: vi.fn().mockRejectedValue(new Error('token info refused')),
    }
    mockOauthClient.callback.mockResolvedValue({ session })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
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

    expect(config.initRepo).toHaveBeenCalledWith('did:plc:rei')
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({ custody: 'stratos' }),
    )
  })

  it('grants pds custody, resolves the user own #atproto key, and creates no Stratos repo', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const did = 'did:plc:asuka'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did, `atproto ${buildSpaceScope(config.serviceDid)}`),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue(atprotoDidDoc(did, keypair))

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

    expect(config.initRepo).not.toHaveBeenCalled()
    expect(config.createSigningKey).not.toHaveBeenCalled()
    expect(mockIdResolver.did.resolve).toHaveBeenCalledWith(did)
    expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        did,
        signingKeyDid: keypair.did(),
        custody: 'pds',
        repoHost: 'https://pds.example.com',
      }),
    )
    expect(mockProfileRecordWriter.putEnrollmentRecord).toHaveBeenCalledWith(
      did,
      expect.any(String),
      expect.objectContaining({
        signingKey: keypair.did(),
        custody: 'pds',
        repoHost: 'https://pds.example.com',
      }),
    )
  })

  it('fails closed when the DID document has no usable #atproto key', async () => {
    const did = 'did:plc:shinji'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did, `atproto ${buildSpaceScope(config.serviceDid)}`),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue({
      id: did,
      verificationMethod: [],
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

    expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    expect(mockProfileRecordWriter.putEnrollmentRecord).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('sends the same attestation payload shape for both custody classes', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })

    // stratos custody
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor('did:plc:misato'),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    const stratosHandler = handleCallback(config)
    await stratosHandler(
      {
        url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      } as any,
      {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any,
    )
    expect(config.createAttestation).toHaveBeenCalledWith(
      'did:plc:misato',
      expect.any(Array),
      'did:key:zQ3sh...',
    )

    // pds custody
    config.createAttestation.mockClear()
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(
        'did:plc:asuka2',
        `atproto ${buildSpaceScope(config.serviceDid)}`,
      ),
    })
    mockEnrollmentValidator.validate.mockResolvedValue({
      allowed: true,
      pdsEndpoint: 'https://pds.example.com',
    })
    mockIdResolver.did.resolve.mockResolvedValue(
      atprotoDidDoc('did:plc:asuka2', keypair),
    )
    const pdsHandler = handleCallback(config)
    await pdsHandler(
      {
        url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      } as any,
      {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any,
    )
    expect(config.createAttestation).toHaveBeenCalledWith(
      'did:plc:asuka2',
      expect.any(Array),
      keypair.did(),
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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    expect(res.redirect!).toHaveBeenCalledWith(
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
    const req: MockRequest = {
      url: 'http://localhost:3100/oauth/callback?code=foo&state=bar',
      cookies: { stratos_redirect: 'https://evil.example/' },
    }
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'https://stratos.example/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=secret-code&state=bar',
    )
    const res: MockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    }

    await callHandler(handler, req, res)

    const target = new URL(res.redirect!.mock.calls[0][0])
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
    const req = makeReq(
      'http://localhost:3100/oauth/callback?code=foo&state=bar',
    )
    const res = makeRes()

    await callHandler(handler, req, res)

    // Should still return success
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        enrolled: false,
      }),
    )
  })

  describe('spaces capability detection', () => {
    // Keep the shared fixture. A `did:web` service DID carries `%3A` for its
    // port, and interpolating that raw into the scope used to break the match
    // silently, so the encoded form is the case worth defending.
    const SERVICE_DID = 'did:web:localhost%3A3100'

    beforeEach(() => {
      config.serviceDid = SERVICE_DID
      mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
      // A 'capable' verdict routes into pds provisioning, which resolves the
      // user's own #atproto key. Without this the request 500s and a
      // log-only assertion still passes, hiding the failure.
      mockIdResolver.did.resolve.mockResolvedValue({
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
        id: 'did:plc:kenshin',
        verificationMethod: [
          {
            id: 'did:plc:kenshin#atproto',
            type: 'Multikey',
            controller: 'did:plc:kenshin',
            publicKeyMultibase:
              'zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme',
          },
        ],
      })
    })

    it.each([
      ['did:web:localhost%3A3100', 'a did:web with an encoded port'],
      ['did:web:127.0.0.1%3A3100', 'the e2e service DID'],
      ['did:web:stratos.example.com', 'a did:web with no port'],
      ['did:plc:kaoru', 'a did:plc'],
    ])('reports capable for %s (%s)', async (serviceDid) => {
      config.serviceDid = serviceDid
      const session = sessionFor(
        'did:plc:kenshin',
        `atproto ${buildSpaceScope(serviceDid)}`,
      )
      const res = await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'capable' },
        'detected PDS spaces capability',
      )
      // The verdict has to reach the stored enrollment. Asserting only the
      // log lets a later failure pass unnoticed.
      expect(res.status).not.toHaveBeenCalledWith(500)
      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ custody: 'pds' }),
      )
    })

    async function runCallback(session: unknown) {
      mockOauthClient.callback.mockResolvedValue({ session })
      const handler = handleCallback(config)
      const req = makeReq(
        'http://localhost:3100/oauth/callback?code=foo&state=bar',
      )
      const res = makeRes()
      await callHandler(handler, req, res)
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

    it('reports unknown when the token response carried no scope', async () => {
      const session = {
        sub: 'did:plc:kenshin',
        getTokenInfo: vi.fn().mockResolvedValue({}),
      }
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'unknown' },
        'detected PDS spaces capability',
      )
      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ custody: 'stratos' }),
      )
    })

    it('reports not-capable when the grant can read but cannot create', async () => {
      // Custody decides where this user's records are written, so a read-only
      // grant is not capable of the flow we would put them in.
      const readOnly =
        `atproto space:zone.stratos.space.feed?authority=${SERVICE_DID}` +
        `&collection=zone.stratos.feed.post&action=read`
      const session = sessionFor('did:plc:kenshin', readOnly)
      await runCallback(session)

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: 'did:plc:kenshin', spacesCapability: 'not-capable' },
        'detected PDS spaces capability',
      )
      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({ custody: 'stratos' }),
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

  it('refuses pds custody when the DID document names no PDS', async () => {
    // Open mode returns eligibility without resolving the document, so the
    // enrolment result carries no endpoint. A pds custody row without a host
    // has nowhere to sync from and must not be stored.
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const did = 'did:plc:misato'
    mockOauthClient.callback.mockResolvedValue({
      session: sessionFor(did, `atproto ${buildSpaceScope(config.serviceDid)}`),
    })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)
    // No pdsEndpoint, exactly as open mode returns it.
    mockEnrollmentValidator.validate.mockResolvedValue({ allowed: true })
    const doc = atprotoDidDoc(did, keypair)
    mockIdResolver.did.resolve.mockResolvedValue({ ...doc, service: [] })

    const handler = handleCallback(config)
    const res = makeRes()
    await callHandler(handler, makeReq(), res)

    expect(mockEnrollmentStore.enroll).not.toHaveBeenCalled()
    expect(mockProfileRecordWriter.putEnrollmentRecord).not.toHaveBeenCalled()
  })
})
