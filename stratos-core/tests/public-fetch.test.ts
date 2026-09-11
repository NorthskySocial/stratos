import dns from 'node:dns'
import { createServer, type RequestListener, type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import {
  createPublicFetch,
  isPublicAddress,
  publicFetch,
  publicLookup,
} from '../src/network/public-fetch.js'

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: vi.fn(actual.fetch) }
})

const servers: Server[] = []

async function serve(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  syncBuiltinESMExports()
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  )
})

describe('public outbound transport', () => {
  it('uses a dispatcher-aware transport on Deno and preserves Request data', async () => {
    vi.stubGlobal('Deno', {})
    const nativeFetch = vi.spyOn(globalThis, 'fetch')
    const response = new Response('{}')
    const transport = vi
      .mocked(undiciFetch)
      .mockResolvedValueOnce(response as never)
    const controller = new AbortController()
    const request = new Request('https://nerv.jp/token', {
      method: 'POST',
      body: 'Evangelion',
      headers: { authorization: 'Bearer test' },
      signal: controller.signal,
    })
    expect(await (await publicFetch(request)).text()).toBe('{}')
    const [url, init] = transport.mock.calls.at(-1)!
    expect(url).toBe(request.url)
    expect(init).toMatchObject({
      method: 'POST',
      headers: [...request.headers],
      redirect: 'error',
      duplex: 'half',
      body: expect.any(ReadableStream),
      signal: expect.any(AbortSignal),
      dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
    })
    expect(await new Response(init!.body as BodyInit).text()).toBe('Evangelion')
    controller.abort()
    expect(init!.signal!.aborted).toBe(true)
    expect(nativeFetch).not.toHaveBeenCalled()
  })
  it.each([{}, { all: true }, { family: 4 }])(
    'connects to the checked DNS answer with options %j',
    (options) => {
      const addresses = [{ address: '8.8.8.8', family: 4 }]
      const lookupAll = (
        _host: string,
        _opts: dns.LookupOptions,
        callback: (error: null, addresses: dns.LookupAddress[]) => void,
      ) => callback(null, addresses)
      const lookup = vi
        .spyOn(dns, 'lookup')
        .mockImplementation(lookupAll as typeof dns.lookup)
      syncBuiltinESMExports()
      const callback = vi.fn()
      publicLookup('nerv.jp', options, callback)
      expect(lookup).toHaveBeenCalledWith(
        'nerv.jp',
        { ...options, all: true },
        expect.any(Function),
      )
      if ('all' in options)
        expect(callback).toHaveBeenCalledWith(null, addresses)
      else expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
      expect(callback).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects an empty DNS answer', () => {
    const lookupAll = (
      _host: string,
      _opts: dns.LookupOptions,
      callback: (error: null, addresses: dns.LookupAddress[]) => void,
    ) => callback(null, [])
    vi.spyOn(dns, 'lookup').mockImplementation(lookupAll as typeof dns.lookup)
    syncBuiltinESMExports()
    const callback = vi.fn()
    publicLookup('nerv.jp', {}, callback)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UnsafeOutboundAddress',
        message: 'Outbound destination is not a public address',
      }),
      '',
    )
  })

  it('propagates DNS errors without connecting', () => {
    const error = new Error('NERV DNS unavailable')
    const lookupAll = (
      _host: string,
      _opts: dns.LookupOptions,
      callback: (error: Error) => void,
    ) => callback(error)
    vi.spyOn(dns, 'lookup').mockImplementation(lookupAll as typeof dns.lookup)
    syncBuiltinESMExports()
    const callback = vi.fn()
    publicLookup('nerv.jp', {}, callback)
    expect(callback).toHaveBeenCalledWith(error, '')
  })
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'fec0::1',
    '::127.0.0.1',
  ])('refuses the reserved address %s before fetching', async (address) => {
    expect(isPublicAddress(address)).toBe(false)
    const transport = vi.fn()
    const fetch = createPublicFetch(transport)
    const hostname = address.includes(':') ? `[${address}]` : address
    await expect(
      fetch(`https://${hostname}/.well-known/did.json`),
    ).rejects.toMatchObject({
      code: 'UnsafeOutboundAddress',
      message: 'Outbound destination is not a public address',
    })
    expect(transport).not.toHaveBeenCalled()
  })

  it.each(['localhost', 'nerv.example', 'not an IP', '999.1.1.1'])(
    'does not treat %s as a validated public address',
    (address) => {
      expect(isPublicAddress(address)).toBe(false)
    },
  )

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '3000::1'])(
    'accepts the public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )

  it.each([
    'http://nerv.jp/xrpc/com.atproto.repo.getRecord',
    'file:///etc/hosts',
    'data:application/json,{}',
    'https://shinji@nerv.jp/',
    'https://:evangelion@nerv.jp/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://127.1/',
  ])('rejects an unsafe URL %s', async (url) => {
    const transport = vi.fn()
    await expect(createPublicFetch(transport)(url)).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it('preserves request data and overrides redirect modes with the protected dispatcher', async () => {
    const response = new Response('{}')
    const transport = vi.fn().mockResolvedValue(response)
    const fetch = createPublicFetch(transport)
    const input = new Request(
      'https://nerv.jp:8443/xrpc/com.atproto.repo.createRecord',
      {
        method: 'POST',
        body: 'Evangelion',
        headers: { authorization: 'Bearer test' },
        redirect: 'follow',
      },
    )
    const signal = new AbortController().signal
    expect(
      await (await fetch(input, { signal, redirect: 'manual' })).text(),
    ).toBe('{}')
    expect(transport).toHaveBeenCalledWith(input, {
      signal: expect.any(AbortSignal),
      redirect: 'error',
      dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
    })
  })

  it('reports an unsafe URL without including URL credentials', async () => {
    await expect(
      createPublicFetch()('https://shinji:secret@nerv.jp'),
    ).rejects.toMatchObject({
      code: 'UnsafeOutboundUrl',
      message: 'Outbound requests require an HTTPS URL without credentials',
    })
  })

  it('uses the protected transport when no fetch override is supplied', async () => {
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'))
    await publicFetch(new URL('https://nerv.jp/'))
    expect(transport).toHaveBeenCalledWith(new URL('https://nerv.jp/'), {
      redirect: 'error',
      signal: expect.any(AbortSignal),
      dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
    })
  })

  it.each([
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    [{ address: '::ffff:7f00:1', family: 6 }],
  ])(
    'rejects private DNS answers before opening the socket: %j',
    async (...addresses) => {
      const received = vi.fn<RequestListener>((_req, res) => {
        res.end('{}')
      })
      const origin = await serve(received)
      const port = new URL(origin).port
      const lookupAll = (
        _host: string,
        _opts: dns.LookupOptions,
        callback: (error: null, addresses: dns.LookupAddress[]) => void,
      ) => {
        callback(null, addresses)
      }
      const lookup = vi
        .spyOn(dns, 'lookup')
        .mockImplementation(lookupAll as typeof dns.lookup)
      syncBuiltinESMExports()
      await expect(
        publicFetch(`https://nerv.jp:${port}/`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: 'UnsafeOutboundAddress' }),
      })
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(received).not.toHaveBeenCalled()
    },
  )

  it.each([301, 302, 303, 307, 308])(
    'never follows an HTTP %i redirect',
    async (status) => {
      const internal = vi.fn<RequestListener>((_req, res) => {
        res.end('{"secret":"Evangelion"}')
      })
      const internalOrigin = await serve(internal)
      const redirector = await serve((_req, res) => {
        res.writeHead(status, { location: `${internalOrigin}/internal.json` })
        res.end()
      })
      // Route the initial request to a local fixture; exercise native fetch redirect handling.
      const fetch = createPublicFetch((_input, init) =>
        globalThis.fetch(redirector, {
          ...init,
          dispatcher: undefined,
        } as RequestInit),
      )
      await expect(
        fetch('https://nerv.jp/.well-known/did.json', {
          redirect: 'follow',
        }),
      ).rejects.toThrow()
      expect(internal).not.toHaveBeenCalled()
    },
  )
})
