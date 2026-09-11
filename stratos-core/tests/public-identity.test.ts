import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryCache,
  PoorlyFormattedDidError,
  UnsupportedDidWebPathError,
} from '@atproto/identity'
import {
  createPublicIdResolver,
  didWebDocumentUrl,
} from '../src/network/identity.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('public identity resolution', () => {
  it.each(['caller', 'timeout'])(
    'propagates the %s abort to HTTP handle resolution',
    async (aborted) => {
      const caller = new AbortController()
      const timeout = new AbortController()
      const timeoutFactory = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(timeout.signal)
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('did:plc:shinji'))
      await createPublicIdResolver({ timeout: 1234 }).handle.resolveHttp(
        'nerv.jp',
        caller.signal,
      )
      const signal = fetch.mock.calls[0][1]!.signal!
      expect(timeoutFactory).toHaveBeenCalledWith(1234)
      expect(signal.aborted).toBe(false)
      ;(aborted === 'caller' ? caller : timeout).abort()
      expect(signal.aborted).toBe(true)
    },
  )

  it('bounds DID resolution and HTTP handles without a caller signal', async () => {
    const timeout = new AbortController()
    const timeoutFactory = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"did:web:nerv.jp"}'))
    const resolver = createPublicIdResolver({ timeout: 4321 })
    await resolver.did.resolve('did:web:nerv.jp')
    expect(fetch.mock.calls[0][1]?.signal).toBe(timeout.signal)
    await resolver.handle.resolveHttp('nerv.jp')
    expect(fetch.mock.calls[1][1]?.signal).toBe(timeout.signal)
    expect(timeoutFactory.mock.calls).toEqual([[4321], [4321]])
  })
  it.each([
    'did:web:nerv.jp%2Finternal',
    'did:web:nerv.jp%5Cinternal',
    'did:web:nerv.jp%3Fquery',
    'did:web:nerv.jp%23fragment',
    'did:web:shinji%40nerv.jp',
    'did:web:',
    'did:plc:shinji',
  ])('rejects a malformed DID authority %s', (did) => {
    expect(() => didWebDocumentUrl(did)).toThrow(PoorlyFormattedDidError)
  })

  it('rejects DID paths and preserves an encoded port', () => {
    expect(() => didWebDocumentUrl('did:web:nerv.jp:shinji')).toThrow(
      UnsupportedDidWebPathError,
    )
    expect(didWebDocumentUrl('did:web:nerv.jp%3A8443').href).toBe(
      'https://nerv.jp:8443/.well-known/did.json',
    )
  })

  it.each([
    'did:web:127.0.0.1',
    'did:web:169.254.169.254',
    'did:web:%5B%3A%3A1%5D',
  ])('refuses an internal DID %s without sending a request', async (did) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(createPublicIdResolver().did.resolve(did)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains DID validation, cache, timeout, and refresh through the protected transport', async () => {
    vi.useFakeTimers()
    const did = 'did:web:nerv.jp'
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ id: did })))
    const cache = new MemoryCache()
    const resolver = createPublicIdResolver({
      didCache: cache,
      timeout: 1234,
      plcUrl: 'https://plc.nerv.jp',
    })
    expect(resolver.did.cache).toBe(cache)
    await expect(resolver.did.resolve(did)).resolves.toEqual({ id: did })
    await resolver.did.resolve(did)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://nerv.jp/.well-known/did.json'),
      {
        headers: { accept: 'application/did+ld+json,application/json' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
        dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
      },
    )
    await resolver.did.resolve(did, true)
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockImplementation(
      async () => new Response(JSON.stringify({ id: 'did:web:rei.jp' })),
    )
    await expect(resolver.did.resolve(did, true)).rejects.toThrow()
  })

  it('keeps missing DID documents as not found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    )
    await expect(
      createPublicIdResolver().did.resolve('did:web:nerv.jp'),
    ).resolves.toBeNull()
  })

  it('keeps the operator-configured PLC endpoint and disallows redirects there', async () => {
    const did = 'did:plc:shinji'
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: did })))
    await expect(
      createPublicIdResolver({ plcUrl: 'http://127.0.0.1:2582' }).did.resolve(
        did,
      ),
    ).resolves.toEqual({ id: did })
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:2582/did%3Aplc%3Ashinji'),
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('resolves HTTP handles on the fixed path and returns the first trimmed DID line', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('  did:plc:shinji  \nignored'))
    const signal = new AbortController().signal
    await expect(
      createPublicIdResolver().handle.resolveHttp('shinji.nerv.jp', signal),
    ).resolves.toBe('did:plc:shinji')
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://shinji.nerv.jp/.well-known/atproto-did'),
      {
        redirect: 'error',
        signal: expect.any(AbortSignal),
        dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
      },
    )
  })

  it.each(['shinji@nerv.jp', 'nerv.jp/private', 'nerv.jp:8443', 'nerv.jp?x=1'])(
    'does not fetch a malformed handle %s',
    async (handle) => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      await expect(
        createPublicIdResolver().handle.resolveHttp(handle),
      ).resolves.toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    new Response('did:plc:shinji', { status: 500 }),
    new Response('not a DID'),
  ])('ignores invalid HTTP handle responses', async (response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(
      createPublicIdResolver().handle.resolveHttp('nerv.jp'),
    ).resolves.toBeUndefined()
  })

  it('ignores HTTP handle transport failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('blocked'))
    await expect(
      createPublicIdResolver().handle.resolveHttp('nerv.jp'),
    ).resolves.toBeUndefined()
  })
})
