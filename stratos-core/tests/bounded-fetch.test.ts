import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundedFetch,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../src/network/bounded-fetch.js'
import { createPublicFetch } from '../src/network/public-fetch.js'

const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  )
})

describe('outbound response limits', () => {
  it('uses the upstream 512 KiB and 10 second limits', () => {
    expect(MAX_RESPONSE_BYTES).toBe(512 * 1024)
    expect(REQUEST_TIMEOUT_MS).toBe(10_000)
  })

  it('accepts exactly the limit and preserves response metadata and cloning', async () => {
    const response = new Response('x'.repeat(512 * 1024), {
      status: 201,
      statusText: 'Created',
      headers: { 'content-length': String(512 * 1024), 'x-nerv': 'Rei' },
    })
    Object.defineProperty(response, 'url', {
      value: 'https://nerv.jp/document',
    })
    const bounded = await createPublicFetch(
      vi.fn().mockResolvedValue(response),
    )('https://nerv.jp/document')
    expect(bounded.status).toBe(201)
    expect(bounded.statusText).toBe('Created')
    expect(bounded.url).toBe('https://nerv.jp/document')
    expect(bounded.headers.get('x-nerv')).toBe('Rei')
    const clone = bounded.clone()
    expect(await bounded.text()).toHaveLength(512 * 1024)
    expect(await clone.text()).toHaveLength(512 * 1024)
  })

  it.each([undefined, '1'])(
    'bounds streamed bytes when Content-Length is %s and cancels the source',
    async (contentLength) => {
      const cancel = vi.fn()
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(32 * 1024))
          },
          cancel,
        }),
        { headers: contentLength ? { 'content-length': contentLength } : {} },
      )
      const bounded = await createPublicFetch(
        vi.fn().mockResolvedValue(response),
      )('https://nerv.jp/document')
      await expect(bounded.text()).rejects.toThrow('Response too large')
      await expect.poll(() => cancel.mock.calls.length).toBe(1)
    },
  )

  it('rejects a declared oversize body without reading it and cancels the source', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(512 * 1024 + 1) },
    })
    await expect(
      createPublicFetch(vi.fn().mockResolvedValue(response))(
        'https://nerv.jp/document',
      ),
    ).rejects.toThrow('Response too large')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('preserves bodyless responses', async () => {
    const response = new Response(null, { status: 204 })
    const fetch = createBoundedFetch(vi.fn().mockResolvedValue(response))
    await expect(fetch('https://nerv.jp/document')).resolves.toBe(response)
  })

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)(
    'bounds %s responses after decompression',
    async (encoding, compress) => {
      const compressed = compress(Buffer.from('あ'.repeat(200_000)))
      expect(compressed.byteLength).toBeLessThan(512 * 1024)
      const server = createServer((_request, response) => {
        response.writeHead(200, {
          'content-encoding': encoding,
          'content-length': compressed.byteLength,
        })
        response.end(compressed)
      })
      servers.push(server)
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/document`
      const response = await createBoundedFetch()(url)
      await expect(response.text()).rejects.toThrow('Response too large')
    },
  )

  it.each(['timeout', 'request', 'init'])(
    'propagates a %s abort while preserving request options',
    async (source) => {
      const timeout = new AbortController()
      const requestAbort = new AbortController()
      const initAbort = new AbortController()
      const timeoutFactory = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(timeout.signal)
      const transport = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () =>
              reject(init!.signal!.reason),
            )
          }),
      )
      const input = new Request('https://nerv.jp/token', {
        method: 'POST',
        headers: { authorization: 'Bearer Rei' },
        body: 'Evangelion',
        signal: requestAbort.signal,
      })
      const init = source === 'init' ? { signal: initAbort.signal } : undefined
      const result = createBoundedFetch(transport)(input, init)
      const rejected = expect(result).rejects.toThrow('Shinji cancelled')
      const controller = { timeout, request: requestAbort, init: initAbort }[
        source
      ]!
      if (source === 'init') {
        requestAbort.abort()
        expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(false)
      }
      controller.abort(new Error('Shinji cancelled'))
      await rejected
      expect(transport.mock.calls[0][0]).toBe(input)
      expect(timeoutFactory).toHaveBeenCalledWith(10_000)
    },
  )
})
