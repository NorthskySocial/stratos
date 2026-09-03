import { AddressInfo } from 'node:net'
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { StratosError } from '@northskysocial/stratos-core'

import {
  UpstreamStratosClient,
  StratosClientError,
  StratosInvalidResponseError,
  describeUpstreamError,
} from '../src/upstream/index.js'

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

interface MockServer {
  server: Server
  baseUrl: string
  requests: CapturedRequest[]
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ) => void | Promise<void>
}

async function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = []
  const ctx: MockServer = {
    server: undefined as unknown as Server,
    baseUrl: '',
    requests,
    handler: (_req, res) => {
      res.statusCode = 500
      res.end('no handler installed')
    },
  }
  ctx.server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      })
      try {
        const ret = ctx.handler(req, res, body)
        if (ret instanceof Promise) ret.catch(() => res.end())
      } catch {
        res.statusCode = 500
        res.end('handler threw')
      }
    })
  })
  await new Promise<void>((resolve) =>
    ctx.server.listen(0, '127.0.0.1', resolve),
  )
  const addr = ctx.server.address() as AddressInfo
  ctx.baseUrl = `http://127.0.0.1:${addr.port}`
  return ctx
}

const FEEDGEN_DID = 'did:web:feedgen.test'
const STRATOS_DID = 'did:web:stratos.test'

function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
} {
  const [headerB64, payloadB64] = token.split('.')
  const decode = (s: string) =>
    JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'))
  return { header: decode(headerB64), payload: decode(payloadB64) }
}

describe('UpstreamStratosClient', () => {
  let mock: MockServer
  let client: UpstreamStratosClient
  let keypair: Secp256k1Keypair

  beforeEach(async () => {
    mock = await startMockServer()
    keypair = await Secp256k1Keypair.create({ exportable: true })
    client = new UpstreamStratosClient({
      serviceUrl: mock.baseUrl,
      serviceDid: STRATOS_DID,
      feedgenDid: FEEDGEN_DID,
      keypair,
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  })

  describe('resolveEnrollments', () => {
    it('GETs the endpoint and qualifies returned boundaries', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            did: 'did:plc:user',
            enrolled: true,
            boundaries: ['engineering'],
          }),
        )
      }
      const result = await client.resolveEnrollments('did:plc:user')
      expect(result).toEqual({
        did: 'did:plc:user',
        enrolled: true,
        boundaries: [`${STRATOS_DID}/engineering`],
      })
      expect(mock.requests).toHaveLength(1)
      const req = mock.requests[0]
      expect(req.method).toBe('GET')
      expect(req.url).toBe(
        '/xrpc/zone.stratos.identity.resolveEnrollments?did=did%3Aplc%3Auser',
      )
    })

    it('ignores boundaries that belong to another service', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            did: 'did:plc:user',
            enrolled: true,
            boundaries: [
              'engineering',
              'did:web:previous-service.test/engineering',
            ],
          }),
        )
      }

      await expect(client.resolveEnrollments('did:plc:user')).resolves.toEqual({
        did: 'did:plc:user',
        enrolled: true,
        boundaries: [`${STRATOS_DID}/engineering`],
      })
    })

    it('uses empty boundaries for unenrolled responses', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ did: 'did:plc:user', enrolled: false }))
      }

      await expect(client.resolveEnrollments('did:plc:user')).resolves.toEqual({
        did: 'did:plc:user',
        enrolled: false,
        boundaries: [],
      })
    })

    it('rejects enrolled responses with invalid boundaries', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ did: 'did:plc:user', enrolled: true }))
      }

      await expect(client.resolveEnrollments('did:plc:user')).rejects.toThrow(
        'resolveEnrollments returned invalid boundaries',
      )
    })

    it('rejects enrolled responses with non-string boundaries', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            did: 'did:plc:user',
            enrolled: true,
            boundaries: ['engineering', 17],
          }),
        )
      }

      await expect(
        client.resolveEnrollments('did:plc:user'),
      ).rejects.toBeInstanceOf(StratosInvalidResponseError)
    })

    it('signs requests with a valid service JWT', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('{"did":"x","enrolled":false,"boundaries":[]}')
      }
      const before = Math.floor(Date.now() / 1000)
      await client.resolveEnrollments('did:plc:x')
      const after = Math.floor(Date.now() / 1000)

      const auth = mock.requests[0].headers.authorization
      expect(auth).toMatch(/^Bearer /)
      const token = (auth as string).slice('Bearer '.length)
      const { payload } = decodeJwt(token)
      expect(payload.iss).toBe(FEEDGEN_DID)
      expect(payload.aud).toBe(STRATOS_DID)
      expect(payload.lxm).toBe('zone.stratos.identity.resolveEnrollments')
      expect(typeof payload.exp).toBe('number')
      expect(payload.exp).toBeGreaterThanOrEqual(before)
      expect(payload.exp).toBeLessThanOrEqual(after + 60)
    })

    it('throws StratosClientError on non-2xx', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 503
        res.end('upstream down')
      }
      await expect(
        client.resolveEnrollments('did:plc:x'),
      ).rejects.toMatchObject({
        name: 'StratosClientError',
        status: 503,
        body: 'upstream down',
        lxm: 'zone.stratos.identity.resolveEnrollments',
      })
    })

    it('bounds the authority request with the configured timeout', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal)
          return new Response(
            JSON.stringify({
              did: 'did:plc:user',
              enrolled: true,
              boundaries: ['engineering'],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        },
      )
      const timedClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
        fetch: fetchImpl as typeof fetch,
        requestTimeoutMs: 1_000,
      })

      await timedClient.resolveEnrollments('did:plc:user')
      expect(fetchImpl).toHaveBeenCalledOnce()
    })
  })

  describe('hydrateRecords', () => {
    it('POSTs uris and returns hydrated payload', async () => {
      mock.handler = (_req, res, body) => {
        expect(JSON.parse(body)).toEqual({
          uris: ['at://did:plc:a/zone.stratos.feed.post/1'],
        })
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            records: [
              { uri: 'at://x', cid: 'bafy', value: { hello: 'world' } },
            ],
            notFound: [],
            blocked: [],
          }),
        )
      }
      const result = await client.hydrateRecords([
        'at://did:plc:a/zone.stratos.feed.post/1',
      ])
      expect(result.records).toHaveLength(1)
      expect(mock.requests[0].method).toBe('POST')
      expect(mock.requests[0].headers['content-type']).toBe('application/json')
      const { payload } = decodeJwt(
        (mock.requests[0].headers.authorization as string).slice(7),
      )
      expect(payload.lxm).toBe('zone.stratos.repo.hydrateRecords')
    })
  })

  describe('getBlob', () => {
    it('returns a stream and content type without buffering', async () => {
      // 256 KiB body — larger than typical highWaterMark
      const chunk = Buffer.alloc(64 * 1024, 0x41)
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'image/png')
        res.setHeader('content-length', String(chunk.length * 4))
        res.write(chunk)
        res.write(chunk)
        res.write(chunk)
        res.write(chunk)
        res.end()
      }
      const { stream, contentType, contentLength } = await client.getBlob(
        'did:plc:user',
        'bafyblob',
      )
      expect(contentType).toBe('image/png')
      expect(contentLength).toBe(chunk.length * 4)
      let total = 0
      for await (const piece of stream) {
        total += (piece as Buffer).length
      }
      expect(total).toBe(chunk.length * 4)
      const { payload } = decodeJwt(
        (mock.requests[0].headers.authorization as string).slice(7),
      )
      expect(payload.lxm).toBe('com.atproto.sync.getBlob')
      expect(mock.requests[0].url).toBe(
        '/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Auser&cid=bafyblob',
      )
    })

    it('throws StratosClientError on 404', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 404
        res.end('blob not found')
      }
      await expect(
        client.getBlob('did:plc:user', 'bafyblob'),
      ).rejects.toMatchObject({
        status: 404,
        body: 'blob not found',
      })
    })
  })

  describe('mintServiceAuthToken', () => {
    it('returns a JWT for the subscribeRecords lxm', async () => {
      const token = await client.mintServiceAuthToken()
      const { payload } = decodeJwt(token)
      expect(payload.iss).toBe(FEEDGEN_DID)
      expect(payload.aud).toBe(STRATOS_DID)
      expect(payload.lxm).toBe('zone.stratos.sync.subscribeRecords')
    })
  })

  describe('getSpaceCredential', () => {
    it('POSTs space + delegationToken and sends the mint proof as the dpop header', async () => {
      mock.handler = (_req, res, body) => {
        expect(JSON.parse(body)).toEqual({
          space:
            'at://did:web:stratos.test/space/zone.stratos.space.feed/spike',
          delegationToken: 'delegation-token-value',
        })
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            credential: 'credential-value',
            expiresAt: '2026-01-01T00:00:00.000Z',
          }),
        )
      }
      const result = await client.getSpaceCredential({
        space: 'at://did:web:stratos.test/space/zone.stratos.space.feed/spike',
        delegationToken: 'delegation-token-value',
        buildMintProof: async (htu) => `proof-for-${htu}`,
      })
      expect(result).toEqual({
        credential: 'credential-value',
        expiresAt: '2026-01-01T00:00:00.000Z',
      })
      expect(mock.requests).toHaveLength(1)
      const req = mock.requests[0]
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/xrpc/zone.stratos.space.getSpaceCredential')
      expect(req.headers.dpop).toBe(
        `proof-for-${mock.baseUrl}/xrpc/zone.stratos.space.getSpaceCredential`,
      )
      expect(req.headers['content-type']).toBe('application/json')
      expect(req.headers.accept).toBe('application/json')
      expect(req.headers.authorization).toBeUndefined()
    })

    it('builds the mint proof htu from publicUrl, not serviceUrl, while still sending the request to serviceUrl', async () => {
      const publicClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        publicUrl: 'https://stratos.public.test',
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
      })
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            credential: 'credential-value',
            expiresAt: '2026-01-01T00:00:00.000Z',
          }),
        )
      }
      await publicClient.getSpaceCredential({
        space: 'at://did:web:stratos.test/space/zone.stratos.space.feed/spike',
        delegationToken: 'delegation-token-value',
        buildMintProof: async (htu) => `proof-for-${htu}`,
      })
      expect(mock.requests).toHaveLength(1)
      const req = mock.requests[0]
      expect(req.url).toBe('/xrpc/zone.stratos.space.getSpaceCredential')
      expect(req.headers.dpop).toBe(
        'proof-for-https://stratos.public.test/xrpc/zone.stratos.space.getSpaceCredential',
      )
    })

    it('throws StratosClientError on non-2xx (e.g. NotEnrolled)', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'NotEnrolled' }))
      }
      await expect(
        client.getSpaceCredential({
          space:
            'at://did:web:stratos.test/space/zone.stratos.space.feed/spike',
          delegationToken: 'delegation-token-value',
          buildMintProof: async () => 'proof',
        }),
      ).rejects.toMatchObject({
        name: 'StratosClientError',
        status: 400,
        lxm: 'zone.stratos.space.getSpaceCredential',
      })
    })

    it('aborts an unresponsive credential request at the configured timeout', async () => {
      let receivedSignal: AbortSignal | null | undefined
      const fetchImpl = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal
          const signal = init?.signal
          if (!signal) return
          const rejectForAbort = () => reject(signal.reason)
          if (signal.aborted) {
            rejectForAbort()
          } else {
            signal.addEventListener('abort', rejectForAbort, { once: true })
          }
        })
      const timeoutClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
        fetch: fetchImpl,
        requestTimeoutMs: 10,
      })

      const request = timeoutClient.getSpaceCredential({
        space: 'at://did:web:stratos.test/space/zone.stratos.space.feed/spike',
        delegationToken: 'delegation-token-value',
        buildMintProof: async () => 'proof',
      })
      let guardTimer!: ReturnType<typeof setTimeout>
      const hangGuard = new Promise<never>((_resolve, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error('getSpaceCredential did not time out')),
          500,
        )
      })
      try {
        await expect(Promise.race([request, hangGuard])).rejects.toMatchObject({
          name: 'TimeoutError',
        })
      } finally {
        clearTimeout(guardTimer)
      }
      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      expect(receivedSignal?.aborted).toBe(true)
    })
  })

  describe('listSpaceRepos', () => {
    function fakeCredentialProof(credential = 'space-credential-value') {
      const proofCalls: Array<{ htm: string; htu: string }> = []
      return {
        credential,
        proofCalls,
        createPresentationProof: async (htm: string, htu: string) => {
          proofCalls.push({ htm, htu })
          return `presentation-proof-for-${htm}-${htu}`
        },
      }
    }

    const SPACE_URI =
      'at://did:web:stratos.test/space/zone.stratos.space.feed/spike'

    it('GETs the mirror with a DPoP credential header and a presentation proof', async () => {
      const credentialProof = fakeCredentialProof()
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            repos: [
              {
                did: 'did:plc:asuka',
                custody: 'pds',
                host: 'https://nerv.example',
                hostSource: 'did-document',
              },
            ],
          }),
        )
      }
      const result = await client.listSpaceRepos(
        { space: SPACE_URI },
        credentialProof,
      )
      expect(result.repos).toEqual([
        {
          did: 'did:plc:asuka',
          custody: 'pds',
          host: 'https://nerv.example',
          hostSource: 'did-document',
        },
      ])
      expect(mock.requests).toHaveLength(1)
      const req = mock.requests[0]
      expect(req.method).toBe('GET')
      expect(req.url).toBe(
        '/xrpc/zone.stratos.space.listRepos?space=at%3A%2F%2Fdid%3Aweb%3Astratos.test%2Fspace%2Fzone.stratos.space.feed%2Fspike',
      )
      expect(req.headers.authorization).toBe('DPoP space-credential-value')
      expect(req.headers.accept).toBe('application/json')
      expect(req.headers.dpop).toBe(
        `presentation-proof-for-GET-${mock.baseUrl}/xrpc/zone.stratos.space.listRepos`,
      )
      expect(credentialProof.proofCalls).toEqual([
        {
          htm: 'GET',
          htu: `${mock.baseUrl}/xrpc/zone.stratos.space.listRepos`,
        },
      ])
    })

    it('sends limit and cursor as query params when provided', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ repos: [], cursor: 'next-cursor' }))
      }
      const result = await client.listSpaceRepos(
        { space: SPACE_URI, limit: 50, cursor: 'prev-cursor' },
        fakeCredentialProof(),
      )
      expect(result).toEqual({ repos: [], cursor: 'next-cursor' })
      const url = new URL(mock.requests[0].url, mock.baseUrl)
      expect(url.searchParams.get('limit')).toBe('50')
      expect(url.searchParams.get('cursor')).toBe('prev-cursor')
    })

    it('builds the presentation proof htu from publicUrl, not serviceUrl', async () => {
      const publicClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        publicUrl: 'https://stratos.public.test',
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
      })
      const credentialProof = fakeCredentialProof()
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ repos: [] }))
      }
      await publicClient.listSpaceRepos({ space: SPACE_URI }, credentialProof)
      expect(mock.requests[0].url).toBe(
        '/xrpc/zone.stratos.space.listRepos?space=at%3A%2F%2Fdid%3Aweb%3Astratos.test%2Fspace%2Fzone.stratos.space.feed%2Fspike',
      )
      expect(credentialProof.proofCalls).toEqual([
        {
          htm: 'GET',
          htu: 'https://stratos.public.test/xrpc/zone.stratos.space.listRepos',
        },
      ])
    })

    it('throws StratosClientError on non-2xx (e.g. AuthRequired)', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'AuthRequired' }))
      }
      await expect(
        client.listSpaceRepos({ space: SPACE_URI }, fakeCredentialProof()),
      ).rejects.toMatchObject({
        name: 'StratosClientError',
        status: 401,
        lxm: 'zone.stratos.space.listRepos',
      })
    })

    it('sets a timeout signal on the membership request', async () => {
      const fetchImpl = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return new Response(JSON.stringify({ repos: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      const timeoutClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
        fetch: fetchImpl,
        requestTimeoutMs: 50,
      })
      await expect(
        timeoutClient.listSpaceRepos(
          { space: SPACE_URI },
          fakeCredentialProof(),
        ),
      ).resolves.toEqual({ repos: [] })
    })

    it('combines caller cancellation with the membership request timeout', async () => {
      let receivedSignal: AbortSignal | null | undefined
      let markRequestStarted!: () => void
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve
      })
      const fetchImpl = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal
          markRequestStarted()
          const signal = init?.signal
          if (!signal) return
          const rejectForAbort = () => reject(signal.reason)
          if (signal.aborted) {
            rejectForAbort()
          } else {
            signal.addEventListener('abort', rejectForAbort, { once: true })
          }
        })
      const cancellableClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
        fetch: fetchImpl,
        requestTimeoutMs: 60_000,
      })
      const controller = new AbortController()

      const request = cancellableClient
        .listSpaceRepos(
          { space: SPACE_URI },
          fakeCredentialProof(),
          controller.signal,
        )
        .catch((cause: unknown) => cause)
      await requestStarted
      controller.abort()

      const error = await request
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      expect(receivedSignal).not.toBe(controller.signal)
      expect(receivedSignal?.aborted).toBe(true)
    })

    it.each([
      ['absent', { did: 'did:plc:asuka' }],
      ['unrecognized', { did: 'did:plc:asuka', custody: 'other' }],
      ['malformed', { did: 'did:plc:asuka', custody: 42 }],
    ])('normalizes %s custody to stratos', async (_name, repo) => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ repos: [repo] }))
      }

      await expect(
        client.listSpaceRepos({ space: SPACE_URI }, fakeCredentialProof()),
      ).resolves.toEqual({
        repos: [{ did: 'did:plc:asuka', custody: 'stratos' }],
      })
    })

    it.each([
      ['an array body', []],
      ['a missing repos field', {}],
      ['a non-object repo', { repos: [null] }],
      ['a repo without a DID', { repos: [{ custody: 'pds' }] }],
      [
        'an invalid host source',
        {
          repos: [
            {
              did: 'did:plc:asuka',
              custody: 'pds',
              hostSource: 'unknown',
            },
          ],
        },
      ],
      ['a non-string cursor', { repos: [], cursor: 42 }],
    ] as const)('rejects %s', async (_name, body) => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      await expect(
        client.listSpaceRepos({ space: SPACE_URI }, fakeCredentialProof()),
      ).rejects.toBeInstanceOf(StratosInvalidResponseError)
    })

    it('rejects a non-JSON response with the typed response error', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.end('not JSON')
      }
      await expect(
        client.listSpaceRepos({ space: SPACE_URI }, fakeCredentialProof()),
      ).rejects.toBeInstanceOf(StratosInvalidResponseError)
    })

    it('does not classify a body timeout as an invalid response', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException('timed out', 'TimeoutError'))
        },
      })
      const timeoutClient = new UpstreamStratosClient({
        serviceUrl: mock.baseUrl,
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
        fetch: async () => new Response(body),
      })
      const err = await timeoutClient
        .listSpaceRepos({ space: SPACE_URI }, fakeCredentialProof())
        .catch((cause: unknown) => cause)
      expect(err).toBeInstanceOf(DOMException)
      expect((err as Error).name).toBe('TimeoutError')
      expect(err).not.toBeInstanceOf(StratosInvalidResponseError)
    })
  })

  describe('trailing slash normalization', () => {
    it('strips a trailing slash from both serviceUrl and publicUrl', async () => {
      const slashClient = new UpstreamStratosClient({
        serviceUrl: `${mock.baseUrl}/`,
        publicUrl: 'https://stratos.public.test/',
        serviceDid: STRATOS_DID,
        feedgenDid: FEEDGEN_DID,
        keypair,
      })
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            credential: 'credential-value',
            expiresAt: '2026-01-01T00:00:00.000Z',
          }),
        )
      }
      await slashClient.getSpaceCredential({
        space: 'at://did:web:stratos.test/space/zone.stratos.space.feed/spike',
        delegationToken: 'delegation-token-value',
        buildMintProof: async (htu) => `proof-for-${htu}`,
      })
      const req = mock.requests[0]
      expect(req.url).toBe('/xrpc/zone.stratos.space.getSpaceCredential')
      expect(req.headers.dpop).toBe(
        'proof-for-https://stratos.public.test/xrpc/zone.stratos.space.getSpaceCredential',
      )
    })
  })

  describe('no JWT caching', () => {
    it('mints a distinct token per call (different jti)', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('{"did":"x","enrolled":false,"boundaries":[]}')
      }
      await client.resolveEnrollments('did:plc:a')
      await client.resolveEnrollments('did:plc:b')
      const jti1 = decodeJwt(
        (mock.requests[0].headers.authorization as string).slice(7),
      ).payload.jti
      const jti2 = decodeJwt(
        (mock.requests[1].headers.authorization as string).slice(7),
      ).payload.jti
      expect(jti1).toBeTruthy()
      expect(jti2).toBeTruthy()
      expect(jti1).not.toBe(jti2)
    })
  })
})

describe('StratosInvalidResponseError', () => {
  it('keeps upstream response failures in the domain error taxonomy', () => {
    const invalid = new StratosInvalidResponseError(
      'https://stratos.bebop.test/xrpc/zone.stratos.space.listSpaceRepos',
      'zone.stratos.space.listSpaceRepos',
      'repos was not an array',
    )
    expect(invalid.message).toBe(
      'Stratos response was invalid: repos was not an array (https://stratos.bebop.test/xrpc/zone.stratos.space.listSpaceRepos)',
    )
    expect(invalid.code).toBe('StratosInvalidResponse')
    const client = new StratosClientError({
      status: 500,
      body: '',
      url: 'https://stratos.bebop.test',
      lxm: 'zone.stratos.space.listSpaceRepos',
    })
    expect(invalid).toBeInstanceOf(StratosError)
    expect(client).toBeInstanceOf(StratosError)
    expect(client.code).toBe('StratosClientError')
  })
})

describe('StratosClientError', () => {
  it('exposes status, body, lxm, url', () => {
    const err = new StratosClientError({
      status: 400,
      body: 'bad',
      url: 'https://x/xrpc/foo',
      lxm: 'foo',
    })
    expect(err.status).toBe(400)
    expect(err.body).toBe('bad')
    expect(err.lxm).toBe('foo')
    expect(err.url).toBe('https://x/xrpc/foo')
    expect(err.name).toBe('StratosClientError')
    expect(err).toBeInstanceOf(StratosError)
    expect(err.code).toBe('StratosClientError')
  })
})

describe('describeUpstreamError', () => {
  it('includes status and lxm for a StratosClientError', () => {
    const err = new StratosClientError({
      status: 400,
      body: JSON.stringify({ error: 'NotEnrolled' }),
      url: 'https://x/xrpc/zone.stratos.space.getSpaceCredential',
      lxm: 'zone.stratos.space.getSpaceCredential',
    })
    expect(describeUpstreamError(err)).toBe(
      '400 zone.stratos.space.getSpaceCredential: NotEnrolled',
    )
  })

  it('logs no part of a body that is not an XRPC error', () => {
    // The body comes from the other end. A misrouted URL could return
    // anything, so none of it belongs in a log line.
    const body = 'x'.repeat(5000)
    const err = new StratosClientError({
      status: 502,
      body,
      url: 'https://x/xrpc/foo',
      lxm: 'foo',
    })
    const described = describeUpstreamError(err)
    expect(described).toBe('502 foo')
    expect(described).not.toContain('x')
  })

  it('logs the error code but never the message', () => {
    const err = new StratosClientError({
      status: 400,
      body: JSON.stringify({
        error: 'NotEnrolled',
        message: 'shinji is not enrolled in nerv',
      }),
      url: 'https://x/xrpc/foo',
      lxm: 'foo',
    })
    const described = describeUpstreamError(err)
    expect(described).toBe('400 foo: NotEnrolled')
    expect(described).not.toContain('shinji')
  })

  it('ignores an error value too long to be a code', () => {
    const err = new StratosClientError({
      status: 400,
      body: JSON.stringify({ error: 'y'.repeat(200) }),
      url: 'https://x/xrpc/foo',
      lxm: 'foo',
    })
    expect(describeUpstreamError(err)).toBe('400 foo')
  })

  it('ignores an error value with characters outside the code grammar', () => {
    // A newline in a logged value forges extra log lines (CWE-117).
    const err = new StratosClientError({
      status: 400,
      body: JSON.stringify({ error: 'Not\nEnrolled' }),
      url: 'https://x/xrpc/foo',
      lxm: 'foo',
    })
    expect(describeUpstreamError(err)).toBe('400 foo')
  })

  it('ignores an empty-string error value', () => {
    const err = new StratosClientError({
      status: 400,
      body: JSON.stringify({ error: '' }),
      url: 'https://x/xrpc/foo',
      lxm: 'foo',
    })
    expect(describeUpstreamError(err)).toBe('400 foo')
  })

  it('reports the error name, not the message, for a plain Error', () => {
    expect(describeUpstreamError(new TypeError('boom'))).toBe('TypeError')
  })

  it('reports nothing from a non-Error throw', () => {
    expect(describeUpstreamError('just a string')).toBe('unknown error')
  })
})
