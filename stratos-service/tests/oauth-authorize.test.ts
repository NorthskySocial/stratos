import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAuthorize } from '../src/oauth/handlers/authorize.js'
import { OAUTH_SCOPE } from '../src/oauth'

const PROOF_REQUIRED =
  'redirect_uri is not declared by a client_id metadata document and its origin is not allow-listed'

describe('handleAuthorize', () => {
  let mockOauthClient: any
  let mockLogger: any
  let mockFetchRedirectUris: any
  let config: any

  beforeEach(() => {
    mockOauthClient = {
      authorize: vi.fn(),
    }
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    mockFetchRedirectUris = vi.fn()
    config = {
      oauthClient: mockOauthClient,
      logger: mockLogger,
      baseUrl: 'http://localhost:3100',
      allowedRedirectOrigins: [],
      fetchClientRedirectUris: mockFetchRedirectUris,
    }
  })

  const makeRes = (): any => ({
    cookie: vi.fn(),
    redirect: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  })

  it('returns 400 if handle is missing', async () => {
    const handler = handleAuthorize(config)
    const req: any = { query: {} }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'InvalidRequest',
        message: 'Handle parameter required',
      }),
    )
  })

  it('redirects to auth URL on success', async () => {
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = { query: { handle: 'alice.test' } }
    const res: any = {
      redirect: vi.fn(),
    }

    await handler(req, res)

    expect(mockOauthClient.authorize).toHaveBeenCalledWith('alice.test', {
      scope: OAUTH_SCOPE,
    })
    expect(res.redirect).toHaveBeenCalledWith(authUrl.toString())
  })

  it('stores the redirect cookie for an allow-listed origin', async () => {
    config.allowedRedirectOrigins = ['https://app.example']
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'alice.test', redirect_uri: 'https://app.example/' },
    }
    const res: any = {
      cookie: vi.fn(),
      redirect: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.cookie).toHaveBeenCalledWith(
      'stratos_redirect',
      'https://app.example/',
      expect.objectContaining({ httpOnly: true }),
    )
    expect(res.redirect).toHaveBeenCalledWith(authUrl.toString())
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects an unproved redirect_uri and names the fix', async () => {
    config.allowedRedirectOrigins = ['https://app.example']

    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'alice.test', redirect_uri: 'https://evil.example/' },
    }
    const res: any = {
      cookie: vi.fn(),
      redirect: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'InvalidRequest',
        message: PROOF_REQUIRED,
        hint: expect.stringContaining('client_id'),
      }),
    )
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { clientId: undefined, message: PROOF_REQUIRED },
      'rejected enrollment redirect_uri',
    )
    expect(res.cookie).not.toHaveBeenCalled()
    expect(mockOauthClient.authorize).not.toHaveBeenCalled()
  })

  it('rejects an unproved redirect_uri when no logger is configured', async () => {
    config.logger = undefined

    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'alice.test', redirect_uri: 'https://evil.example/' },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('accepts a redirect_uri declared by the client_id document', async () => {
    mockFetchRedirectUris.mockResolvedValue(['https://app.example/'])
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'motoko.test',
        redirect_uri: 'https://app.example/enrolled',
        client_id: 'https://app.example/client-metadata.json',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(mockFetchRedirectUris).toHaveBeenCalledWith(
      'https://app.example/client-metadata.json',
    )
    expect(res.cookie).toHaveBeenCalledWith(
      'stratos_redirect',
      'https://app.example/enrolled',
      expect.objectContaining({ httpOnly: true }),
    )
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects a redirect_uri the client_id document does not declare', async () => {
    mockFetchRedirectUris.mockResolvedValue(['https://app.example/'])

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'motoko.test',
        redirect_uri: 'https://evil.example/',
        client_id: 'https://app.example/client-metadata.json',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'redirect_uri origin is not declared by the client_id',
      }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('rejects the redirect when the client_id document cannot be read', async () => {
    mockFetchRedirectUris.mockRejectedValue(new Error('connection refused'))

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'batou.test',
        redirect_uri: 'https://app.example/',
        client_id: 'https://app.example/client-metadata.json',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('connection refused'),
      }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('does not read the client_id document for an allow-listed origin', async () => {
    config.allowedRedirectOrigins = ['https://app.example']
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'togusa.test',
        redirect_uri: 'https://app.example/',
        client_id: 'https://app.example/client-metadata.json',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(mockFetchRedirectUris).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects every redirect_uri when nothing proves it', async () => {
    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'alice.test', redirect_uri: 'https://app.example/' },
    }
    const res: any = {
      cookie: vi.fn(),
      redirect: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('rejects a redirect_uri that is not a parsable URL', async () => {
    config.allowedRedirectOrigins = ['https://app.example']

    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'usagi.test', redirect_uri: 'not-a-url' },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'InvalidRequest',
        message: 'Invalid redirect_uri',
      }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
    expect(mockOauthClient.authorize).not.toHaveBeenCalled()
  })

  it('rejects a disallowed scheme even when its origin is allow-listed', async () => {
    config.allowedRedirectOrigins = ['ftp://app.example']

    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'mamoru.test', redirect_uri: 'ftp://app.example/' },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'InvalidRequest',
        message: 'redirect_uri must use https',
      }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
    expect(mockOauthClient.authorize).not.toHaveBeenCalled()
  })

  it('accepts an http redirect_uri when the service itself is http', async () => {
    config.allowedRedirectOrigins = ['http://app.example']
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'spike-spiegel.test',
        redirect_uri: 'http://app.example/',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.cookie).toHaveBeenCalledWith(
      'stratos_redirect',
      'http://app.example/',
      expect.objectContaining({ secure: false }),
    )
    expect(res.status).not.toHaveBeenCalled()
  })

  it('accepts an https redirect_uri when the service is https', async () => {
    config.baseUrl = 'https://stratos.example'
    config.allowedRedirectOrigins = ['https://app.example']
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'faye-valentine.test',
        redirect_uri: 'https://app.example/',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.cookie).toHaveBeenCalledWith(
      'stratos_redirect',
      'https://app.example/',
      expect.objectContaining({ secure: true }),
    )
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects an http redirect_uri when the service is https', async () => {
    config.baseUrl = 'https://stratos.example'
    config.allowedRedirectOrigins = ['http://app.example']

    const handler = handleAuthorize(config)
    const req: any = {
      query: {
        handle: 'faye-valentine.test',
        redirect_uri: 'http://app.example/',
      },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'redirect_uri must use https' }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('rejects a loopback redirect_uri when devMode is unset', async () => {
    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'usagi.test', redirect_uri: 'http://localhost:5173/' },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: PROOF_REQUIRED,
      }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('accepts a loopback redirect_uri in devMode without an allow-list entry', async () => {
    config.devMode = true
    const authUrl = new URL('https://pds.example.com/oauth/authorize?state=abc')
    mockOauthClient.authorize.mockResolvedValue(authUrl)

    const handler = handleAuthorize(config)
    const req: any = {
      query: { handle: 'usagi.test', redirect_uri: 'http://localhost:5173/' },
    }
    const res = makeRes()

    await handler(req, res)

    expect(res.cookie).toHaveBeenCalledWith(
      'stratos_redirect',
      'http://localhost:5173/',
      expect.objectContaining({ httpOnly: true }),
    )
    expect(mockFetchRedirectUris).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.redirect).toHaveBeenCalledWith(authUrl.toString())
  })

  it('returns 400 if authorize fails with a resolution error', async () => {
    mockOauthClient.authorize.mockRejectedValue(
      new Error('Handle resolution failed'),
    )

    const handler = handleAuthorize(config)
    const req: any = { query: { handle: 'alice.test' } }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'AuthorizationError',
        message: 'Failed to start authorization flow',
      }),
    )
  })

  it('includes error message in devMode', async () => {
    config.devMode = true
    mockOauthClient.authorize.mockRejectedValue(
      new Error('Handle resolution failed'),
    )

    const handler = handleAuthorize(config)
    const req: any = { query: { handle: 'alice.test' } }
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'AuthorizationError',
        message: 'Failed to start authorization flow: Handle resolution failed',
      }),
    )
  })
})
