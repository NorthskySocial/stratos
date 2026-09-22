import { describe, expect, it, vi } from 'vitest'

import { compareFeedEndpoints } from './compare.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('compareFeedEndpoints', () => {
  it('compares private responses without reporting their identifiers', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          cursor: 'private-cursor',
          feed: [
            {
              post: {
                uri: 'at://did:plc:spike/zone.stratos.feed.post/one',
                cid: 'bafyone',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          cursor: 'private-cursor',
          feed: [
            {
              post: {
                uri: 'at://did:plc:spike/zone.stratos.feed.post/one',
                cid: 'bafyone',
              },
            },
          ],
        }),
      )

    await expect(
      compareFeedEndpoints({
        tsBaseUrl: 'http://127.0.0.1:3000',
        rustBaseUrl: 'http://[::1]:3001',
        authorization: 'Bearer private-token',
        feed: 'bebop',
        cursor: 'private-cursor',
        limit: 50,
        fetch,
      }),
    ).resolves.toEqual({ outcome: 'matched', tsStatus: 200, rustStatus: 200 })
    expect(fetch.mock.calls).toHaveLength(2)
    for (const [url, options] of fetch.mock.calls) {
      expect(String(url)).not.toContain('private-token')
      expect(options?.headers).toEqual({
        authorization: 'Bearer private-token',
      })
      expect(options?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('returns only a bounded mismatch reason for divergent private pages', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ feed: [] }))
      .mockResolvedValueOnce(
        response({
          feed: [
            {
              post: {
                uri: 'at://did:plc:faye/zone.stratos.feed.post/two',
                cid: 'bafytwo',
              },
            },
          ],
        }),
      )

    await expect(
      compareFeedEndpoints({
        tsBaseUrl: 'http://localhost:3000',
        rustBaseUrl: 'http://localhost:3001',
        authorization: 'Bearer private-token',
        feed: 'bebop',
        fetch,
      }),
    ).resolves.toEqual({
      outcome: 'mismatch',
      reason: 'post-count',
      tsStatus: 200,
      rustStatus: 200,
    })
  })

  it('rejects remote endpoints before sending an authorization header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()

    await expect(
      compareFeedEndpoints({
        tsBaseUrl: 'https://ts.example.test',
        rustBaseUrl: 'http://127.0.0.1:3001',
        authorization: 'Bearer private-token',
        feed: 'bebop',
        fetch,
      }),
    ).rejects.toThrow('compare requires loopback endpoints')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds a stalled endpoint by the configured request deadline', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('request aborted'))
          })
        }),
    )

    await expect(
      compareFeedEndpoints({
        tsBaseUrl: 'http://localhost:3000',
        rustBaseUrl: 'http://localhost:3001',
        authorization: 'Bearer private-token',
        feed: 'bebop',
        requestTimeoutMs: 10,
        fetch,
      }),
    ).rejects.toThrow('request aborted')
  })
})
