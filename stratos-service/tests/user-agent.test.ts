import { describe, it, expect, vi } from 'vitest'
import { buildUserAgent, createFetchWithUserAgent } from '../src/user-agent.js'

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

  it('preserves existing headers', async () => {
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

  it('uses globalThis.fetch when no baseFetch provided', () => {
    const wrappedFetch = createFetchWithUserAgent('Stratos/0.1.0')
    expect(typeof wrappedFetch).toBe('function')
  })
})
