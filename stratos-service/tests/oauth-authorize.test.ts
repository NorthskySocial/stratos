import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAuthorize } from '../src/oauth/handlers/authorize.js'
import { OAUTH_SCOPE } from '../src/oauth'

describe('handleAuthorize', () => {
  let mockOauthClient: any
  let mockLogger: any
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
    config = {
      oauthClient: mockOauthClient,
      logger: mockLogger,
      baseUrl: 'http://localhost:3100',
    }
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

  it('rejects a redirect_uri whose origin is not allow-listed', async () => {
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
        message: 'redirect_uri origin is not allowed',
      }),
    )
    expect(res.cookie).not.toHaveBeenCalled()
    expect(mockOauthClient.authorize).not.toHaveBeenCalled()
  })

  it('rejects every redirect_uri when the allow-list is empty', async () => {
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
