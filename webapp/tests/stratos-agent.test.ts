import { describe, expect, it, vi } from 'vitest'
import { createServiceFetch } from '../src/lib/stratos-agent'
import type { OAuthSession } from '@atproto/oauth-client-browser'

describe('stratos-agent', () => {
  it('createServiceFetch routes relative URLs to serviceUrl', async () => {
    const mockFetchHandler = vi.fn().mockResolvedValue(new Response())
    const mockSession = {
      fetchHandler: mockFetchHandler,
    } as unknown as OAuthSession

    const serviceUrl = 'https://stratos.example.com'
    const fetchFn = createServiceFetch(mockSession, serviceUrl)

    await fetchFn('/xrpc/some.method')

    expect(mockFetchHandler).toHaveBeenCalledWith(
      'https://stratos.example.com/xrpc/some.method',
      undefined,
    )
  })

  it('createServiceFetch routes absolute URLs but resolves them against serviceUrl if relative', async () => {
    const mockFetchHandler = vi.fn().mockResolvedValue(new Response())
    const mockSession = {
      fetchHandler: mockFetchHandler,
    } as unknown as OAuthSession

    const serviceUrl = 'https://stratos.example.com'
    const fetchFn = createServiceFetch(mockSession, serviceUrl)

    await fetchFn('xrpc/some.method') // relative without leading slash

    expect(mockFetchHandler).toHaveBeenCalledWith(
      'https://stratos.example.com/xrpc/some.method',
      undefined,
    )
  })

  it('createServiceFetch rewrites the origin of a URL input', async () => {
    const mockFetchHandler = vi.fn().mockResolvedValue(new Response())
    const mockSession = {
      fetchHandler: mockFetchHandler,
    } as unknown as OAuthSession

    const serviceUrl = 'https://stratos.example.com'
    const fetchFn = createServiceFetch(mockSession, serviceUrl)

    await fetchFn(new URL('https://kusanagi.example.com/xrpc/some.method?a=1'))

    expect(mockFetchHandler).toHaveBeenCalledWith(
      'https://stratos.example.com/xrpc/some.method?a=1',
      undefined,
    )
  })

  it('createServiceFetch rejects a Request instead of dropping its method and body', async () => {
    const mockFetchHandler = vi.fn().mockResolvedValue(new Response())
    const mockSession = {
      fetchHandler: mockFetchHandler,
    } as unknown as OAuthSession

    const serviceUrl = 'https://stratos.example.com'
    const fetchFn = createServiceFetch(mockSession, serviceUrl)

    const request = new Request(
      'https://kusanagi.example.com/xrpc/some.method',
      {
        method: 'POST',
        headers: { 'x-section': 'nine' },
        body: 'payload',
      },
    )

    await expect(fetchFn(request)).rejects.toThrow(TypeError)
    expect(mockFetchHandler).not.toHaveBeenCalled()
  })

  it('handles DPoP nonce retry', async () => {
    const mockFetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'AuthenticationRequired',
            message: 'DPoP nonce required',
          }),
          { status: 401, headers: { 'dpop-nonce': 'new-nonce' } },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))

    const mockSession = {
      fetchHandler: mockFetchHandler,
    } as unknown as OAuthSession

    const serviceUrl = 'https://stratos.example.com'
    const fetchFn = createServiceFetch(mockSession, serviceUrl)

    const res = await fetchFn('/xrpc/some.method')
    const data = await res.json()

    expect(data.success).toBe(true)
    expect(mockFetchHandler).toHaveBeenCalledTimes(2)
  })
})
