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
