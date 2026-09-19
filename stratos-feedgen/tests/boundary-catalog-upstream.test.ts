import { describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { UpstreamStratosClient } from '../src/upstream/client.js'
import { MAX_CATALOG_BYTES } from '../src/feeds/catalog-model.js'

const authority = 'did:web:nerv.example'
const row = {
  boundary: `${authority}/pilots`,
  roomId: 'pilots',
  displayName: 'Pilots',
  description: 'NERV',
  listed: true,
  joinable: false,
  revision: 1,
}
const body = JSON.stringify({ boundaries: [row] })
async function fixture(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
  const client = new UpstreamStratosClient({
    serviceUrl: 'https://nerv.example',
    serviceDid: authority,
    feedgenDid: 'did:web:feed.nerv.example',
    keypair: await Secp256k1Keypair.create(),
    fetch,
  })
  return { client, fetch }
}

describe('upstream boundary catalogue XRPC', () => {
  it('uses method-bound service authentication and propagates cancellation to the bounded body reader', async () => {
    const { client, fetch } = await fixture(new Response(body))
    const signal = new AbortController().signal
    expect(await client.listBoundaries(signal)).toEqual([row])
    const [url, request] = fetch.mock.calls[0]
    expect(url.toString()).toBe(
      'https://nerv.example/xrpc/zone.stratos.sync.listBoundaries',
    )
    expect(request?.method).toBe('GET')
    expect(request?.signal).toBe(signal)
    const headers = new Headers(request?.headers)
    expect(headers.get('accept')).toBe('application/json')
    const token = headers.get('authorization')!.slice('Bearer '.length)
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    )
    expect(claims).toMatchObject({
      iss: 'did:web:feed.nerv.example',
      aud: authority,
      lxm: 'zone.stratos.sync.listBoundaries',
    })
  })

  it('reads chunked catalogue JSON and cancels oversized response bodies', async () => {
    const encoded = Buffer.from(body)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 10))
        controller.enqueue(encoded.subarray(10))
        controller.close()
      },
    })
    const { client } = await fixture(new Response(stream))
    expect(await client.listBoundaries(new AbortController().signal)).toEqual([
      row,
    ])
    const cancel = vi.fn()
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CATALOG_BYTES + 1))
      },
      cancel,
    })
    const large = await fixture(new Response(oversized))
    await expect(
      large.client.listBoundaries(new AbortController().signal),
    ).rejects.toThrow('Boundary catalogue exceeds response limit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('accepts the exact response-byte ceiling', async () => {
    const { client } = await fixture(
      new Response(
        body + ' '.repeat(MAX_CATALOG_BYTES - Buffer.byteLength(body)),
      ),
    )
    expect(await client.listBoundaries(new AbortController().signal)).toEqual([
      row,
    ])
  })

  it('rejects missing bodies, malformed JSON, and foreign boundary authorities', async () => {
    for (const [response, error] of [
      [new Response(null), 'Missing boundary catalogue'],
      [new Response('broken'), 'Unexpected token'],
      [
        new Response(
          JSON.stringify({
            boundaries: [{ ...row, boundary: 'did:web:seele.example/pilots' }],
          }),
        ),
        'Invalid catalogue boundary authority',
      ],
    ] as const) {
      const { client } = await fixture(response)
      await expect(
        client.listBoundaries(new AbortController().signal),
      ).rejects.toThrow(error)
    }
  })

  it('propagates unsupported or unauthorized upstream failures without a static fallback', async () => {
    const { client } = await fixture(
      new Response(JSON.stringify({ error: 'AuthRequired' }), { status: 401 }),
    )
    await expect(
      client.listBoundaries(new AbortController().signal),
    ).rejects.toMatchObject({
      status: 401,
      lxm: 'zone.stratos.sync.listBoundaries',
    })
  })

  it('stops reading after cancellation and releases the body', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const stream = new ReadableStream({
      pull(streamController) {
        controller.abort()
        streamController.enqueue(Buffer.from(body))
      },
      cancel,
    })
    const { client } = await fixture(new Response(stream))
    await expect(client.listBoundaries(controller.signal)).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
