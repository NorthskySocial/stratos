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
})
