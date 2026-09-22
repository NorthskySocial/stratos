import { describe, expect, it, vi } from 'vitest'
import { HttpShadowFeedReader } from '../src/shadow/index.js'

const primary = {
  status: 200,
  cursor: 'private-cursor',
  postIdentifiers: ['at://post/one#cid-one'],
}

function shadowResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('HttpShadowFeedReader', () => {
  it('forwards a sampled request only to its configured sidecar and records a bounded match', async () => {
    const recordShadowFeed = vi.fn()
    const fetch = vi.fn(async () =>
      shadowResponse({
        cursor: 'private-cursor',
        feed: [{ post: { uri: 'at://post/one', cid: 'cid-one' } }],
      }),
    )
    const reader = new HttpShadowFeedReader({
      baseUrl: 'http://127.0.0.1:3001',
      sampleRate: 1,
      requestTimeoutMs: 100,
      maxConcurrent: 1,
      metrics: { recordShadowFeed },
      fetch,
    })

    reader.observe({
      authorization: 'Bearer private-token',
      feed: 'bebop',
      cursor: 'private-cursor',
      limit: 50,
      primary,
    })

    await vi.waitFor(() =>
      expect(recordShadowFeed).toHaveBeenCalledWith('matched'),
    )
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/xrpc/zone.stratos.feedgen.getFeed?feed=bebop&limit=50&cursor=private-cursor',
      expect.objectContaining({
        headers: { authorization: 'Bearer private-token' },
        redirect: 'error',
      }),
    )
  })

  it('reports only a bounded mismatch category', async () => {
    const recordShadowFeed = vi.fn()
    const reader = new HttpShadowFeedReader({
      baseUrl: 'http://127.0.0.1:3001',
      sampleRate: 1,
      requestTimeoutMs: 100,
      maxConcurrent: 1,
      metrics: { recordShadowFeed },
      fetch: async () => shadowResponse({ cursor: 'different', feed: [] }),
    })

    reader.observe({
      authorization: 'Bearer private-token',
      feed: 'bebop',
      limit: 50,
      primary,
    })

    await vi.waitFor(() =>
      expect(recordShadowFeed).toHaveBeenCalledWith('mismatch_cursor'),
    )
    expect(JSON.stringify(recordShadowFeed.mock.calls)).not.toContain('private')
  })

  it('drops a sampled request when the bounded sidecar queue is full', async () => {
    let finish: (() => void) | undefined
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = () =>
            resolve(shadowResponse({ cursor: 'private-cursor', feed: [] }))
        }),
    )
    const recordShadowFeed = vi.fn()
    const reader = new HttpShadowFeedReader({
      baseUrl: 'http://127.0.0.1:3001',
      sampleRate: 1,
      requestTimeoutMs: 100,
      maxConcurrent: 1,
      metrics: { recordShadowFeed },
      fetch,
    })

    reader.observe({
      authorization: 'Bearer token',
      feed: 'bebop',
      limit: 50,
      primary,
    })
    reader.observe({
      authorization: 'Bearer token',
      feed: 'bebop',
      limit: 50,
      primary,
    })

    expect(recordShadowFeed).toHaveBeenCalledWith('dropped')
    expect(fetch).toHaveBeenCalledOnce()
    finish?.()
  })

  it('records an unavailable sidecar without throwing into the request path', async () => {
    const recordShadowFeed = vi.fn()
    const reader = new HttpShadowFeedReader({
      baseUrl: 'http://127.0.0.1:3001',
      sampleRate: 1,
      requestTimeoutMs: 100,
      maxConcurrent: 1,
      metrics: { recordShadowFeed },
      fetch: async () => {
        throw new Error('sidecar unavailable')
      },
    })

    expect(() =>
      reader.observe({
        authorization: 'Bearer token',
        feed: 'bebop',
        limit: 50,
        primary,
      }),
    ).not.toThrow()
    await vi.waitFor(() =>
      expect(recordShadowFeed).toHaveBeenCalledWith('unavailable'),
    )
  })

  it.each([
    [
      'a malformed cursor',
      () => shadowResponse({ cursor: 1, feed: [] }),
      { status: 200, postIdentifiers: [] },
    ],
    [
      'a missing XRPC error',
      () => shadowResponse({}, 400),
      { status: 400, postIdentifiers: [] },
    ],
    [
      'a non-string XRPC error',
      () => shadowResponse({ error: 1 }, 400),
      { status: 400, postIdentifiers: [] },
    ],
  ])(
    'flags %s as an invalid shadow decision',
    async (_name, response, primary) => {
      const recordShadowFeed = vi.fn()
      const reader = new HttpShadowFeedReader({
        baseUrl: 'http://127.0.0.1:3001',
        sampleRate: 1,
        requestTimeoutMs: 100,
        maxConcurrent: 1,
        metrics: { recordShadowFeed },
        fetch: async () => response(),
      })

      reader.observe({
        authorization: 'Bearer private-token',
        feed: 'bebop',
        limit: 50,
        primary,
      })

      await vi.waitFor(() =>
        expect(recordShadowFeed).toHaveBeenCalledWith('mismatch_error'),
      )
      expect(JSON.stringify(recordShadowFeed.mock.calls)).not.toContain(
        'private',
      )
    },
  )
})
