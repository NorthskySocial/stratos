import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchClientRedirectUris,
  verifyRedirectTarget,
} from '../src/oauth/redirect-target.js'

const CLIENT_ID = 'https://app.example/client-metadata.json'

const gates = {
  allowedSchemes: ['https:'],
  allowedRedirectOrigins: [] as string[],
  devMode: false,
}

function stubFetch(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(body: unknown, init?: { status?: number }) {
  const text = JSON.stringify(body)
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers: new Headers({ 'content-length': String(text.length) }),
    text: async () => text,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchClientRedirectUris', () => {
  it('returns the declared redirect_uris', async () => {
    stubFetch(
      jsonResponse({
        client_id: CLIENT_ID,
        redirect_uris: ['https://app.example/'],
      }),
    )

    await expect(fetchClientRedirectUris(CLIENT_ID)).resolves.toEqual([
      'https://app.example/',
    ])
  })

  it('does not follow redirects and bounds the request', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        client_id: CLIENT_ID,
        redirect_uris: ['https://app.example/'],
      }),
    )

    await fetchClientRedirectUris(CLIENT_ID)

    expect(fetchMock).toHaveBeenCalledWith(
      CLIENT_ID,
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it.each([
    ['http://app.example/client-metadata.json', 'plain http'],
    ['https://169.254.169.254/client-metadata.json', 'an IP-literal host'],
    ['https://app.example', 'no path component'],
    ['https://app.example/client-metadata.json#frag', 'a fragment'],
  ])('refuses to read %s (%s)', async (clientId) => {
    const fetchMock = stubFetch(jsonResponse({}))

    await expect(fetchClientRedirectUris(clientId)).rejects.toThrow(
      'client_id is not a discoverable client metadata URL',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a document that names a different client_id', async () => {
    stubFetch(
      jsonResponse({
        client_id: 'https://evil.example/client-metadata.json',
        redirect_uris: ['https://evil.example/'],
      }),
    )

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'does not match its client_id',
    )
  })

  it('rejects a non-ok response', async () => {
    stubFetch(jsonResponse({}, { status: 404 }))

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'returned 404',
    )
  })

  it('rejects an oversized document by its declared length', async () => {
    stubFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(1024 * 1024) }),
      text: async () => '{}',
    })

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'too large',
    )
  })

  it('rejects an oversized document that declares no length', async () => {
    stubFetch({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'x'.repeat(64 * 1024 + 1),
    })

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'too large',
    )
  })

  it('accepts a document of exactly the maximum size', async () => {
    const body = JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uris: ['https://app.example/'],
    }).padEnd(64 * 1024, ' ')
    stubFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(body.length) }),
      text: async () => body,
    })

    await expect(fetchClientRedirectUris(CLIENT_ID)).resolves.toEqual([
      'https://app.example/',
    ])
  })
})

describe('verifyRedirectTarget', () => {
  it('accepts a target whose origin the client_id declares', async () => {
    const fetchUris = vi.fn().mockResolvedValue(['https://app.example/'])

    await expect(
      verifyRedirectTarget(
        'https://app.example/enrolled?tab=feed',
        CLIENT_ID,
        gates,
        fetchUris,
      ),
    ).resolves.toEqual({ allowed: true })
  })

  it('rejects a target on an origin the client_id does not declare', async () => {
    const fetchUris = vi.fn().mockResolvedValue(['https://app.example/'])

    await expect(
      verifyRedirectTarget(
        'https://evil.example/',
        CLIENT_ID,
        gates,
        fetchUris,
      ),
    ).resolves.toEqual({
      allowed: false,
      message: 'redirect_uri origin is not declared by the client_id',
    })
  })

  it('ignores an unparseable entry in the declared list', async () => {
    const fetchUris = vi
      .fn()
      .mockResolvedValue(['not-a-url', 'https://app.example/'])

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({ allowed: true })
  })

  it('rejects when every declared entry is unparseable', async () => {
    const fetchUris = vi.fn().mockResolvedValue(['not-a-url'])

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message: 'redirect_uri origin is not declared by the client_id',
    })
  })

  it('rejects an unparseable redirect_uri', async () => {
    await expect(
      verifyRedirectTarget('not-a-url', CLIENT_ID, gates, vi.fn()),
    ).resolves.toEqual({ allowed: false, message: 'Invalid redirect_uri' })
  })

  it('rejects a disallowed scheme before reading any document', async () => {
    const fetchUris = vi.fn()

    await expect(
      verifyRedirectTarget('http://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message: 'redirect_uri must use https',
    })
    expect(fetchUris).not.toHaveBeenCalled()
  })

  it('reports why the client_id document could not be read', async () => {
    const fetchUris = vi.fn().mockRejectedValue(new Error('connection refused'))

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message:
        'could not verify redirect_uri against client_id: connection refused',
    })
  })

  it('reports a non-Error rejection from the document read', async () => {
    const fetchUris = vi.fn().mockRejectedValue('offline')

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message: 'could not verify redirect_uri against client_id: offline',
    })
  })

  it('accepts an allow-listed origin without a client_id', async () => {
    const fetchUris = vi.fn()

    await expect(
      verifyRedirectTarget(
        'https://app.example/',
        undefined,
        { ...gates, allowedRedirectOrigins: ['https://app.example'] },
        fetchUris,
      ),
    ).resolves.toEqual({ allowed: true })
    expect(fetchUris).not.toHaveBeenCalled()
  })

  it('rejects a target with no client_id and no allow-list entry', async () => {
    await expect(
      verifyRedirectTarget('https://app.example/', undefined, gates, vi.fn()),
    ).resolves.toEqual({
      allowed: false,
      message:
        'redirect_uri is not declared by a client_id metadata document and its origin is not allow-listed',
    })
  })
})
