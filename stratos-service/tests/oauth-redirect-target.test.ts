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

/**
 * Build a real Response. The reader streams the body and counts its bytes, so a
 * stub that replaces `text()` would hide what the size cap does.
 */
function textResponse(
  text: string,
  init?: { status?: number; contentLength?: number },
) {
  const headers = new Headers()
  headers.set(
    'content-length',
    String(init?.contentLength ?? Buffer.byteLength(text)),
  )
  return new Response(text, { status: init?.status ?? 200, headers })
}

function jsonResponse(body: unknown, init?: { status?: number }) {
  return textResponse(JSON.stringify(body), init)
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

    expect(fetchMock).toHaveBeenCalledWith(CLIENT_ID, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
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
    stubFetch(textResponse('{}', { contentLength: 1024 * 1024 }))

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'too large',
    )
  })

  it('rejects an oversized document that declares no length', async () => {
    const response = new Response('x'.repeat(64 * 1024 + 1))

    stubFetch(response)

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'too large',
    )
  })

  it('rejects a document that passes the cap only when counted in UTF-16 units', async () => {
    // Each of these characters is three bytes in UTF-8 and one UTF-16 code
    // unit. A count of code units would put this document under the cap.
    const filler = '　'.repeat(32 * 1024)
    const body = JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uris: ['https://app.example/'],
      client_name: filler,
    })
    expect(body.length).toBeLessThan(64 * 1024)
    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024)

    stubFetch(new Response(body))

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'too large',
    )
  })

  it('accepts a document of exactly the maximum size', async () => {
    const body = JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uris: ['https://app.example/'],
    }).padEnd(64 * 1024, ' ')
    stubFetch(textResponse(body))

    await expect(fetchClientRedirectUris(CLIENT_ID)).resolves.toEqual([
      'https://app.example/',
    ])
  })

  it('joins a multi-byte character split across two chunks', async () => {
    // The character sits in the returned value, so a decode that mangles it
    // changes the result rather than hiding in a field nobody reads.
    const redirectUri = 'https://app.example/キツネ'
    const document = JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uris: [redirectUri],
    })
    const bytes = Buffer.from(document, 'utf8')
    // Cut inside the three bytes of the first Japanese character. A decoder
    // that treats each chunk as complete emits a replacement character here.
    const split = bytes.indexOf(Buffer.from('キ', 'utf8')) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, split)))
        controller.enqueue(new Uint8Array(bytes.subarray(split)))
        controller.close()
      },
    })

    stubFetch(new Response(body))

    await expect(fetchClientRedirectUris(CLIENT_ID)).resolves.toEqual([
      redirectUri,
    ])
  })

  it('rejects a response that carries no body', async () => {
    stubFetch(new Response(null, { status: 204 }))

    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'client metadata document is empty',
    )
  })

  it('stops reading a body that never ends', async () => {
    let pushed = 0
    const chunk = new Uint8Array(16 * 1024)
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed += chunk.byteLength
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })

    stubFetch(new Response(body))

    // Rejecting at all is the point: this stream never ends, so a reader that
    // buffered the whole body before measuring it would never return.
    await expect(fetchClientRedirectUris(CLIENT_ID)).rejects.toThrow(
      'too large',
    )
    // Bound loosely. The stream queues chunks ahead of the reader, so the exact
    // total depends on the queuing strategy rather than on the cap.
    expect(pushed).toBeLessThan(1024 * 1024)
    expect(cancelled).toBe(true)
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

  it('does not match a declared private-use scheme entry', async () => {
    // A native client may legally declare "com.example.app:/callback". The URL
    // parser gives such an entry the opaque origin "null", which must never
    // match a web target.
    const fetchUris = vi.fn().mockResolvedValue(['com.example.app:/callback'])

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message: 'redirect_uri origin is not declared by the client_id',
    })
  })

  it('refuses a private-use scheme target before reading any document', async () => {
    const fetchUris = vi.fn()

    await expect(
      verifyRedirectTarget(
        'com.example.app:/callback',
        CLIENT_ID,
        gates,
        fetchUris,
      ),
    ).resolves.toEqual({
      allowed: false,
      message: 'redirect_uri must use https',
    })
    expect(fetchUris).not.toHaveBeenCalled()
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

  it('keeps the document read failure in logDetail, not in the message', async () => {
    const fetchUris = vi
      .fn()
      .mockRejectedValue(new Error('client metadata document returned 403'))

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message:
        'could not verify redirect_uri against the client_id metadata document',
      logDetail: 'client metadata document returned 403',
    })
  })

  it('keeps a non-Error rejection in logDetail too', async () => {
    const fetchUris = vi.fn().mockRejectedValue('ECONNREFUSED 10.0.0.5:443')

    await expect(
      verifyRedirectTarget('https://app.example/', CLIENT_ID, gates, fetchUris),
    ).resolves.toEqual({
      allowed: false,
      message:
        'could not verify redirect_uri against the client_id metadata document',
      logDetail: 'ECONNREFUSED 10.0.0.5:443',
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
