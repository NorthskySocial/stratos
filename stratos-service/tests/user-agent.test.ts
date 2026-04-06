import { describe, expect, it, vi } from 'vitest'
import { buildUserAgent, createFetchWithUserAgent } from '../src'

describe('buildUserAgent', () => {
  it('builds user-agent string with undefined operator contact', () => {
    const result = buildUserAgent(
      '0.1.0',
      'https://github.com/example/fork',
      undefined,
    )

    expect(result).toBe('Stratos/0.1.0 (+https://github.com/example/fork)')
  })

  it('builds user-agent string with repo URL and operator contact', () => {
    const result = buildUserAgent(
      '0.1.0',
      'https://github.com/NorthskySocial/northsky-stratos',
      'operator@example.com',
    )

    expect(result).toBe(
      'Stratos/0.1.0 (+https://github.com/NorthskySocial/northsky-stratos; operator@example.com)',
    )
  })
})

describe('createFetchWithUserAgent', () => {
  it('injects User-Agent header into requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    const wrappedFetch = createFetchWithUserAgent('Stratos/0.1.0', mockFetch)

    await wrappedFetch('https://example.com/api')

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/api')
    expect(init?.headers?.get('User-Agent')).toBe('Stratos/0.1.0')
  })

  it('preserves existing headers from init', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    const wrappedFetch = createFetchWithUserAgent('Stratos/0.1.0', mockFetch)

    await wrappedFetch('https://example.com/api', {
      headers: { Accept: 'application/json' },
    })

    const [, init] = mockFetch.mock.calls[0]
    const headers = init?.headers
    expect(headers?.get('Accept')).toBe('application/json')
    expect(headers?.get('User-Agent')).toBe('Stratos/0.1.0')
  })

  it('preserves existing headers from a Request object', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    const wrappedFetch = createFetchWithUserAgent('Stratos/0.1.0', mockFetch)

    const request = new Request('https://example.com/api', {
      headers: {
        Authorization: 'DPoP some-token',
        DPoP: 'some-proof',
      },
    })

    await wrappedFetch(request)

    const [, init] = mockFetch.mock.calls[0]
    const headers = init?.headers
    expect(headers?.get('Authorization')).toBe('DPoP some-token')
    expect(headers?.get('DPoP')).toBe('some-proof')
    expect(headers?.get('User-Agent')).toBe('Stratos/0.1.0')
  })

  it('prefers init headers over Request headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'))
    const wrappedFetch = createFetchWithUserAgent('Stratos/0.1.0', mockFetch)

    const request = new Request('https://example.com/api', {
      headers: {
        Authorization: 'from-request',
        'X-Request-Only': 'from-request',
      },
    })

    await wrappedFetch(request, {
      headers: { Authorization: 'from-init' },
    })

    const [, init] = mockFetch.mock.calls[0]
    const headers = init?.headers
    expect(headers?.get('Authorization')).toBe('from-init')
    expect(headers?.get('X-Request-Only')).toBeNull()
    expect(headers?.get('User-Agent')).toBe('Stratos/0.1.0')
  })
})
