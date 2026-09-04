import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import {
  createOAuthRoutes,
  type OAuthRoutesConfig,
} from '../src/oauth/index.js'
import { DpopVerificationError } from '../src/infra/auth/index.js'

function createConfig(dpopVerifier = { verify: vi.fn() }): OAuthRoutesConfig {
  return {
    baseUrl: 'https://stratos.example',
    serviceEndpoint: 'https://stratos.example',
    serviceDid: 'did:web:stratos.example',
    allowedRedirectOrigins: [],
    dpopVerifier,
    enrollmentStore: {
      isEnrolled: vi.fn(),
      enroll: vi.fn(),
      unenroll: vi.fn(),
      getEnrollment: vi.fn().mockResolvedValue(null),
      getBoundaries: vi.fn(),
      setBoundaries: vi.fn(),
      addBoundary: vi.fn(),
      removeBoundary: vi.fn(),
      updateEnrollment: vi.fn(),
    },
    roomCatalog: { list: () => [] },
  } as unknown as OAuthRoutesConfig
}

describe('OAuth route DPoP verification', () => {
  const servers: ReturnType<express.Express['listen']>[] = []

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    )
  })

  it('mounts the custom boundary endpoints under the boundary family', () => {
    const router = createOAuthRoutes(createConfig())
    const paths = router.stack.flatMap((layer) =>
      typeof layer.route?.path === 'string' ? [layer.route.path] : [],
    )

    expect(paths).toEqual(
      expect.arrayContaining([
        '/boundaries',
        '/boundaries/status',
        '/boundaries/post',
      ]),
    )
    expect(paths).not.toEqual(
      expect.arrayContaining(['/rooms', '/rooms/status', '/rooms/post']),
    )
  })

  it('uses the full original URL when the router is mounted at /oauth', async () => {
    const dpopVerifier = {
      verify: vi.fn().mockResolvedValue({ did: 'did:plc:alice' }),
    }
    const app = express()
    app.use('/oauth', createOAuthRoutes(createConfig(dpopVerifier)))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)

    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/boundaries/status`,
      {
        headers: { authorization: 'DPoP proof' },
      },
    )

    expect(response.status).toBe(200)
    expect(dpopVerifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/oauth/boundaries/status',
      }),
      expect.anything(),
    )
  })

  it('falls back to req.url for direct route-handler callers', async () => {
    const dpopVerifier = {
      verify: vi.fn().mockResolvedValue({ did: 'did:plc:alice' }),
    }
    const router = createOAuthRoutes(createConfig(dpopVerifier))
    const handler = router.stack.find(
      (layer) => layer.route?.path === '/status',
    )?.route?.stack[0]?.handle
    const response = {
      json: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    await handler?.(
      {
        headers: { authorization: 'DPoP proof' },
        method: 'GET',
        url: '/status',
      } as never,
      response as never,
      vi.fn(),
    )

    expect(dpopVerifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/status' }),
      expect.anything(),
    )
  })

  it('returns the DPoP nonce challenge headers needed for an automatic retry', async () => {
    const dpopVerifier = {
      verify: vi.fn().mockRejectedValue(
        new DpopVerificationError(
          'DPoP nonce required',
          'use_dpop_nonce',
          'DPoP error="use_dpop_nonce"',
          'next-nonce',
        ),
      ),
    }
    const app = express()
    app.use('/oauth', createOAuthRoutes(createConfig(dpopVerifier)))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)

    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/boundaries/status`,
      { headers: { authorization: 'DPoP token' } },
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      'DPoP error="use_dpop_nonce"',
    )
    expect(response.headers.get('dpop-nonce')).toBe('next-nonce')
  })

  it.each([
    ['a Bearer DID', 'Bearer did:plc:alice'],
    ['a missing authorization header', undefined],
    ['a non-DPoP authorization scheme', 'Basic credentials'],
  ])(
    'rejects %s in production without invoking the DPoP verifier',
    async (_description, authorization) => {
      const dpopVerifier = { verify: vi.fn() }
      const app = express()
      app.use('/oauth', createOAuthRoutes(createConfig(dpopVerifier)))
      const server = app.listen(0, '127.0.0.1')
      servers.push(server)

      await new Promise<void>((resolve) => server.once('listening', resolve))
      const { port } = server.address() as AddressInfo
      const response = await fetch(
        `http://127.0.0.1:${port}/oauth/boundaries/status`,
        authorization ? { headers: { authorization } } : undefined,
      )

      expect(response.status).toBe(401)
      expect(dpopVerifier.verify).not.toHaveBeenCalled()
    },
  )
})
