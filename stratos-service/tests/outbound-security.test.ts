import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdResolver } from '../src/identity-resolver.js'
import type { StratosServiceConfig } from '../src/config.js'
import { JwksResolver } from '../src/infra/auth/jwks-resolver.js'
import { PdsTokenVerifier } from '../src/infra/auth/introspection-client.js'

afterEach(() => vi.restoreAllMocks())

describe('service outbound security', () => {
  it('keeps the configured PLC endpoint through the protected resolver factory', async () => {
    const did = 'did:plc:shinji'
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: did })))
    const resolver = createIdResolver(
      {
        identity: { plcUrl: 'http://127.0.0.1:2582' },
        enrollment: { serviceEnrollments: [] },
      } as unknown as StratosServiceConfig,
      fetch,
    )
    await expect(resolver.did.resolve(did)).resolves.toEqual({ id: did })
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:2582/did%3Aplc%3Ashinji'),
      expect.objectContaining({ redirect: 'error' }),
    )
  })
  it('blocks private DID resolution through the service factory', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const resolver = createIdResolver(
      {
        identity: { plcUrl: 'https://plc.nerv.jp' },
        enrollment: { serviceEnrollments: [] },
      } as unknown as StratosServiceConfig,
      fetch,
    )
    await expect(resolver.did.resolve('did:web:127.0.0.1')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let invalid handles escape the PLC fallback path', async () => {
    const fetch = vi.fn()
    const resolver = createIdResolver(
      {
        identity: { plcUrl: 'http://127.0.0.1:2582' },
        enrollment: { serviceEnrollments: [] },
      } as unknown as StratosServiceConfig,
      fetch,
    )
    await expect(resolver.handle.resolve('..')).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the protected socket transport for client metadata and jwks_uri', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jwks_uri: 'https://keys.nerv.jp/jwks.json' }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [{ kty: 'EC', kid: 'rei' }] })),
      )
    await new JwksResolver({ fetch }).resolveJwks('https://nerv.jp/client.json')
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
        dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
      })
    }
  })

  it('protects PDS metadata fetched for an unverified token', async () => {
    const did = 'did:plc:shinji'
    const idResolver = {
      did: {
        resolve: vi.fn().mockResolvedValue({
          id: did,
          service: [{ id: '#atproto_pds', serviceEndpoint: 'https://nerv.jp' }],
        }),
      },
    }
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ authorization_servers: ['https://nerv.jp'] }),
        ),
      )
    const verifier = new PdsTokenVerifier({
      idResolver: idResolver as never,
      fetch,
    })
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: did, iss: 'https://nerv.jp' })).toString('base64url')}.signature`
    await verifier.verify(token)
    expect(fetch).toHaveBeenCalledWith(
      'https://nerv.jp/.well-known/oauth-protected-resource',
      expect.objectContaining({
        redirect: 'error',
        dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
      }),
    )
  })
})
