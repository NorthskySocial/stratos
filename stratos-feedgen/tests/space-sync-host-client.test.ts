import { AddressInfo } from 'node:net'
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StratosError } from '@northskysocial/stratos-core'
import {
  createDpopProof,
  generateDpopKeyPair,
  type DpopKeyPair,
} from '../src/space-credential/dpop.js'
import {
  DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
  DEFAULT_SPACE_SYNC_PAGE_LIMIT,
} from '../src/config.js'
import type { SpaceCredentialProof } from '../src/upstream/index.js'
import {
  getRecordResponseByteLimit,
  getRepoOpsResponseByteLimit,
  InsecureHostOriginError,
  InvalidHostOriginError,
  MalformedCursorError,
  PrivateHostOriginError,
  RepoNotFoundError,
  SpaceHostClient,
  SpaceHostClientError,
  SpaceHostInvalidResponseError,
  SpaceHostRedirectError,
  SpaceHostRequestError,
  SpaceHostResponseTooLargeError,
  SpaceHostTimeoutError,
  SpaceHostUnreachableError,
  SpaceNotFoundError,
} from '../src/space-sync/index.js'
import type { SpaceHostClientOptions } from '../src/space-sync/index.js'
import { createPinnedLookup } from '../src/space-sync/host-client.js'

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
}

interface MockServer {
  server: Server
  baseUrl: string
  requests: CapturedRequest[]
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
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
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
    })
    try {
      const ret = ctx.handler(req, res)
      if (ret instanceof Promise) ret.catch(() => res.end())
    } catch {
      res.statusCode = 500
      res.end('handler threw')
    }
  })
  await new Promise<void>((resolve) =>
    ctx.server.listen(0, '127.0.0.1', resolve),
  )
  const addr = ctx.server.address() as AddressInfo
  ctx.baseUrl = `http://127.0.0.1:${addr.port}`
  return ctx
}

function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
} {
  const [headerB64, payloadB64] = token.split('.')
  const decode = (s: string) =>
    JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'))
  return { header: decode(headerB64), payload: decode(payloadB64) }
}

const CREDENTIAL = 'held-space-credential-jwt'
const SPACE_URI =
  'at://did:web:stratos.test/space/zone.stratos.space.feed/bebop'
const REPO_DID = 'did:plc:spike'

/** Mirrors `SpaceCredentialManager`'s real `toHeld()` binding, not a stub string. */
async function makeCredentialProof(): Promise<SpaceCredentialProof> {
  const keyPair: DpopKeyPair = await generateDpopKeyPair()
  return {
    credential: CREDENTIAL,
    createPresentationProof: (htm: string, htu: string) =>
      createDpopProof(keyPair, { htm, htu, credential: CREDENTIAL }),
  }
}

describe('SpaceHostClient', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockServer()
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  })

  /**
   * The mock server only speaks plain http, so every test that expects a
   * real round trip opts that one origin into the allowlist. Tests that
   * exercise the allowlist itself override it explicitly.
   */
  async function createClient(
    overrides: Partial<SpaceHostClientOptions> = {},
  ): Promise<SpaceHostClient> {
    return new SpaceHostClient({
      hostOrigin: mock.baseUrl,
      credentialProof: await makeCredentialProof(),
      allowHttpOrigins: new Set([mock.baseUrl]),
      ...overrides,
    })
  }

  describe('listRepoOps', () => {
    it('GETs the foreign endpoint with a DPoP credential header and a presentation proof carrying ath', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ops: [
              {
                rev: '1',
                collection: 'zone.stratos.feed.post',
                rkey: 'a1',
                cid: 'bafyA',
                value: { text: 'see you space cowboy' },
              },
            ],
            cursor: '1/0',
          }),
        )
      }
      const client = await createClient()

      const result = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
      })

      expect(result).toEqual({
        ops: [
          {
            rev: '1',
            collection: 'zone.stratos.feed.post',
            rkey: 'a1',
            cid: 'bafyA',
            value: { text: 'see you space cowboy' },
          },
        ],
        cursor: '1/0',
        commit: undefined,
      })

      expect(mock.requests).toHaveLength(1)
      const req = mock.requests[0]
      expect(req.method).toBe('GET')
      expect(req.url.startsWith('/xrpc/com.atproto.space.listRepoOps?')).toBe(
        true,
      )
      expect(req.headers.authorization).toBe(`DPoP ${CREDENTIAL}`)
      expect(req.headers.accept).toBe('application/json')

      const url = new URL(req.url, mock.baseUrl)
      expect(url.searchParams.has('limit')).toBe(false)
      expect(url.searchParams.has('cursor')).toBe(false)

      const { header, payload } = decodeJwt(req.headers.dpop as string)
      expect(header.typ).toBe('dpop+jwt')
      expect(payload.htm).toBe('GET')
      expect(payload.htu).toBe(
        `${mock.baseUrl}/xrpc/com.atproto.space.listRepoOps`,
      )
      expect(typeof payload.ath).toBe('string')
      expect(payload.ath).not.toBe('')
    })

    it('sends space/repo/limit/cursor as query params and pages via cursor', async () => {
      let callCount = 0
      mock.handler = (_req, res) => {
        callCount += 1
        res.setHeader('content-type', 'application/json')
        if (callCount === 1) {
          res.end(
            JSON.stringify({
              ops: [
                {
                  rev: '1',
                  collection: 'zone.stratos.feed.post',
                  rkey: 'a1',
                  cid: 'bafyA',
                },
              ],
              cursor: '1/0',
            }),
          )
        } else {
          res.end(
            JSON.stringify({
              ops: [
                {
                  rev: '2',
                  collection: 'zone.stratos.feed.post',
                  rkey: 'a2',
                  cid: 'bafyB',
                },
              ],
              commit: { ver: 1, rev: '2' },
            }),
          )
        }
      }
      const client = await createClient()

      const page1 = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
        limit: 1,
      })
      expect(page1.cursor).toBe('1/0')
      expect(page1.commit).toBeUndefined()

      const page2 = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
        limit: 1,
        cursor: page1.cursor,
      })
      expect(page2.cursor).toBeUndefined()
      expect(page2.commit).toEqual({ ver: 1, rev: '2' })
      expect(page2.ops[0]).toMatchObject({ cid: 'bafyB' })

      expect(mock.requests).toHaveLength(2)
      const url1 = new URL(mock.requests[0].url, mock.baseUrl)
      expect(url1.searchParams.get('space')).toBe(SPACE_URI)
      expect(url1.searchParams.get('repo')).toBe(REPO_DID)
      expect(url1.searchParams.get('limit')).toBe('1')
      expect(url1.searchParams.has('cursor')).toBe(false)

      const url2 = new URL(mock.requests[1].url, mock.baseUrl)
      expect(url2.searchParams.get('cursor')).toBe('1/0')
    })

    it('accepts a valid page over 1 MiB under the production-derived response cap', async () => {
      const value = {
        $type: 'zone.stratos.feed.post',
        text: '',
      }
      const emptyValueBytes = Buffer.byteLength(JSON.stringify(value))
      value.text = 'x'.repeat(
        DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES - emptyValueBytes,
      )
      expect(Buffer.byteLength(JSON.stringify(value))).toBe(
        DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
      )
      const ops = Array.from({ length: 17 }, (_, index) => ({
        rev: String(index + 1),
        collection: 'zone.stratos.feed.post',
        rkey: `a${index}`,
        cid: `bafy${index}`,
        value,
      }))
      const body = JSON.stringify({ ops })
      const bodyBytes = Buffer.byteLength(body)
      const maxPageBytes = getRepoOpsResponseByteLimit(
        DEFAULT_SPACE_SYNC_PAGE_LIMIT,
        DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
      )
      expect(bodyBytes).toBeGreaterThan(1_048_576)
      expect(bodyBytes).toBeLessThanOrEqual(maxPageBytes)

      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(body)
      }
      const client = await createClient({ maxPageBytes })

      const result = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
        limit: DEFAULT_SPACE_SYNC_PAGE_LIMIT,
      })

      expect(result.ops).toHaveLength(17)
      expect(result.ops[0]?.value).toEqual(value)
    })

    it.each([
      ['MalformedCursor', MalformedCursorError, 'MalformedCursorError'],
      ['RepoNotFound', RepoNotFoundError, 'RepoNotFoundError'],
      ['SpaceNotFound', SpaceNotFoundError, 'SpaceNotFoundError'],
    ] as const)(
      'maps XRPC error %s to a typed %s carrying status/errorCode/url',
      async (code, ErrorClass, expectedName) => {
        mock.handler = (_req, res) => {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: code, message: 'nope' }))
        }
        const client = await createClient()
        const err = await client
          .listRepoOps({ space: SPACE_URI, repo: REPO_DID })
          .catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ErrorClass)
        const typed = err as SpaceHostRequestError
        expect(typed.name).toBe(expectedName)
        expect(typed.status).toBe(400)
        expect(typed.errorCode).toBe(code)
        expect(typed.url).toBe(
          `${mock.baseUrl}/xrpc/com.atproto.space.listRepoOps?space=${encodeURIComponent(SPACE_URI)}&repo=${encodeURIComponent(REPO_DID)}`,
        )
      },
    )

    it('falls back to a generic SpaceHostRequestError for an unnamed XRPC error code', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'RepoTakendown' }))
      }
      const client = await createClient()
      const err = await client
        .listRepoOps({ space: SPACE_URI, repo: REPO_DID })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SpaceHostRequestError)
      expect(err).not.toBeInstanceOf(MalformedCursorError)
      expect((err as SpaceHostRequestError).name).toBe('SpaceHostRequestError')
      expect((err as SpaceHostRequestError).status).toBe(400)
      expect((err as SpaceHostRequestError).errorCode).toBe('RepoTakendown')
    })

    it('falls back to a generic error with no errorCode when the XRPC error field is not a string', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 42 }))
      }
      const client = await createClient()
      const err = await client
        .listRepoOps({ space: SPACE_URI, repo: REPO_DID })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SpaceHostRequestError)
      expect((err as SpaceHostRequestError).errorCode).toBeUndefined()
    })

    it('falls back to a generic error with no errorCode when the error body is not JSON', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain')
        res.end('internal error')
      }
      const client = await createClient()
      const err = await client
        .listRepoOps({ space: SPACE_URI, repo: REPO_DID })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SpaceHostRequestError)
      expect((err as SpaceHostRequestError).status).toBe(500)
      expect((err as SpaceHostRequestError).errorCode).toBeUndefined()
    })

    it('throws SpaceHostInvalidResponseError for a 2xx body missing "ops"', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ notOps: [] }))
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })

    it('throws SpaceHostInvalidResponseError for a 2xx body that is not JSON', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.end('not json')
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })

    it('throws SpaceHostInvalidResponseError for a 2xx body that is valid JSON but not an object', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('42')
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })

    it('throws SpaceHostInvalidResponseError for a 2xx array body', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('[]')
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })

    it('throws SpaceHostInvalidResponseError when an ops entry is not an object', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        // `null` (not a string) so a broken "is it a record" check falls
        // through to a raw property read on `null`, which surfaces as a
        // TypeError rather than the typed error — a distinguishable failure.
        res.end(JSON.stringify({ ops: [null] }))
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })

    const VALID_OP_FIELDS = {
      rev: '1',
      collection: 'zone.stratos.feed.post',
      rkey: 'a1',
    }

    it.each([
      [
        'rev',
        { collection: VALID_OP_FIELDS.collection, rkey: VALID_OP_FIELDS.rkey },
      ],
      ['collection', { rev: VALID_OP_FIELDS.rev, rkey: VALID_OP_FIELDS.rkey }],
      [
        'rkey',
        { rev: VALID_OP_FIELDS.rev, collection: VALID_OP_FIELDS.collection },
      ],
    ] as const)(
      'throws SpaceHostInvalidResponseError when an ops entry is missing "%s"',
      async (_field, entry) => {
        mock.handler = (_req, res) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ops: [entry] }))
        }
        const client = await createClient()
        await expect(
          client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
        ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
      },
    )

    it.each([404, false, {}, undefined] as const)(
      'rejects a non-string cid',
      async (cid) => {
        mock.handler = (_req, res) => {
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              ops: [
                {
                  rev: '1',
                  collection: 'zone.stratos.feed.post',
                  rkey: 'a1',
                  cid,
                },
              ],
            }),
          )
        }
        const client = await createClient()
        await expect(
          client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
        ).rejects.toMatchObject({
          name: 'SpaceHostInvalidResponseError',
          message: expect.stringContaining(
            'op at index 0 had an invalid "cid"',
          ),
        })
      },
    )

    it('accepts a null cid for a deleted record', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ops: [
              {
                rev: '1',
                collection: 'zone.stratos.feed.post',
                rkey: 'a1',
                cid: null,
              },
            ],
          }),
        )
      }
      const client = await createClient()

      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).resolves.toMatchObject({ ops: [{ cid: null }] })
    })

    it('omits an absent inline value from a repo operation', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ops: [
              {
                rev: '1',
                collection: 'zone.stratos.feed.post',
                rkey: 'a1',
                cid: 'bafyA',
              },
            ],
          }),
        )
      }
      const client = await createClient()
      const result = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
      })

      expect(result.ops[0]).not.toHaveProperty('value')
    })

    it('treats a non-string cursor as absent', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ops: [], cursor: 12345 }))
      }
      const client = await createClient()
      const result = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
      })
      expect(result.cursor).toBeUndefined()
    })
  })

  describe('getLatestCommit', () => {
    it('fetches and returns the signed commit envelope', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ commit: { rev: '2', sig: 'signed' } }))
      }
      const client = await createClient()

      await expect(
        client.getLatestCommit({ space: SPACE_URI, repo: REPO_DID }),
      ).resolves.toEqual({ rev: '2', sig: 'signed' })

      const requestUrl = new URL(mock.requests[0].url, mock.baseUrl)
      expect(requestUrl.pathname).toBe(
        '/xrpc/com.atproto.space.getLatestCommit',
      )
      expect(requestUrl.searchParams.get('space')).toBe(SPACE_URI)
      expect(requestUrl.searchParams.get('repo')).toBe(REPO_DID)
    })

    it('rejects a response without a commit object', async () => {
      mock.handler = (_req, res) => {
        res.end(JSON.stringify({}))
      }
      const client = await createClient()

      await expect(
        client.getLatestCommit({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })
  })

  describe('getRecord', () => {
    it('GETs the record and decodes uri/cid/value', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            uri: `at://${REPO_DID}/zone.stratos.feed.post/a1`,
            cid: 'bafyA',
            value: { text: '3, 2, 1, lets jam' },
          }),
        )
      }
      const client = await createClient()

      const result = await client.getRecord({
        space: SPACE_URI,
        repo: REPO_DID,
        collection: 'zone.stratos.feed.post',
        rkey: 'a1',
      })

      expect(result).toEqual({
        uri: `at://${REPO_DID}/zone.stratos.feed.post/a1`,
        cid: 'bafyA',
        value: { text: '3, 2, 1, lets jam' },
      })
      const req = mock.requests[0]
      expect(req.url.startsWith('/xrpc/com.atproto.space.getRecord?')).toBe(
        true,
      )
      const url = new URL(req.url, mock.baseUrl)
      expect(url.searchParams.get('collection')).toBe('zone.stratos.feed.post')
      expect(url.searchParams.get('rkey')).toBe('a1')
    })

    it('surfaces an unnamed error code (e.g. RecordNotFound) as a generic SpaceHostRequestError', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'RecordNotFound' }))
      }
      const client = await createClient()
      const err = await client
        .getRecord({
          space: SPACE_URI,
          repo: REPO_DID,
          collection: 'zone.stratos.feed.post',
          rkey: 'missing',
        })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SpaceHostRequestError)
      expect((err as SpaceHostRequestError).errorCode).toBe('RecordNotFound')
    })

    it.each([
      ['cid', { uri: `at://${REPO_DID}/x/a1` }],
      ['uri', { cid: 'bafyA' }],
    ] as const)(
      'throws SpaceHostInvalidResponseError for a 2xx body missing "%s"',
      async (_field, body) => {
        mock.handler = (_req, res) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const client = await createClient()
        await expect(
          client.getRecord({
            space: SPACE_URI,
            repo: REPO_DID,
            collection: 'zone.stratos.feed.post',
            rkey: 'a1',
          }),
        ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
      },
    )
  })

  describe('hardening', () => {
    it('rejects an invalid host origin with a typed error', async () => {
      const client = await createClient({ hostOrigin: 'not a URL' })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(InvalidHostOriginError)
    })

    it.each([
      '127.0.0.1',
      '10.0.0.1',
      '169.254.1.1',
      '192.168.1.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:7f00:1',
    ])('rejects a host that resolves to %s', async (address) => {
      let fetched = false
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => [address],
        fetch: async () => {
          fetched = true
          return new Response(JSON.stringify({ ops: [] }))
        },
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(PrivateHostOriginError)
      expect(fetched).toBe(false)
    })

    it('rejects a host when any resolved address is private', async () => {
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => ['8.8.8.8', '10.0.0.1'],
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(PrivateHostOriginError)
    })

    it('rejects a private literal address without calling DNS', async () => {
      let resolved = false
      const client = await createClient({
        hostOrigin: 'https://127.0.0.1',
        resolveHost: async () => {
          resolved = true
          return ['8.8.8.8']
        },
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(PrivateHostOriginError)
      expect(resolved).toBe(false)
    })

    it('rejects a host when DNS returns no addresses', async () => {
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => [],
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostUnreachableError)
    })

    it('allows a public address returned by DNS', async () => {
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => ['8.8.8.8'],
        fetch: async () => new Response(JSON.stringify({ ops: [] })),
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).resolves.toMatchObject({ ops: [] })
    })

    it('pins the validated DNS answer into the request transport', async () => {
      const resolveHost = vi.fn(async () => ['8.8.8.8'])
      let dispatcher: unknown
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost,
        fetch: async (_input, init) => {
          dispatcher = (
            init as (RequestInit & { dispatcher?: unknown }) | undefined
          )?.dispatcher
          return new Response(JSON.stringify({ ops: [] }))
        },
      })

      await client.listRepoOps({ space: SPACE_URI, repo: REPO_DID })

      expect(resolveHost).toHaveBeenCalledOnce()
      expect(dispatcher).toBeDefined()
    })

    it('cannot replace a validated public answer before transport lookup', async () => {
      const addresses = ['8.8.8.8']
      const pinnedLookup = createPinnedLookup(addresses)
      addresses[0] = '127.0.0.1'

      const connected = await new Promise<{ address: string; family: number }>(
        (resolve, reject) => {
          pinnedLookup('nerv.example', {}, (err, address, family) => {
            if (err) {
              reject(err)
              return
            }
            if (typeof address !== 'string' || family === undefined) {
              reject(new Error('expected one pinned address'))
              return
            }
            resolve({ address, family })
          })
        },
      )

      expect(connected).toEqual({ address: '8.8.8.8', family: 4 })
    })

    it('bounds a stalled DNS resolver with the request timeout', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        requestTimeoutMs: 25,
        resolveHost: () => new Promise<readonly string[]>(() => {}),
        fetch: fetchImpl,
      })

      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostTimeoutError)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('normalizes a non-Error caller abort reason', async () => {
      const controller = new AbortController()
      controller.abort('cancelled by the caller')
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: () => new Promise<readonly string[]>(() => {}),
      })

      const err = await client
        .listRepoOps({
          space: SPACE_URI,
          repo: REPO_DID,
          signal: controller.signal,
        })
        .catch((reason: unknown) => reason)

      expect(err).toBeInstanceOf(Error)
      expect((err as Error).cause).toBe('cancelled by the caller')
    })

    it('times out a hanging response', async () => {
      mock.handler = () => {
        // Never respond.
      }
      const client = await createClient({ requestTimeoutMs: 50 })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostTimeoutError)
    })

    it('classifies a body-stream timeout as SpaceHostTimeoutError', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException('timed out', 'TimeoutError'))
        },
      })
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => ['8.8.8.8'],
        fetch: async () => new Response(body),
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostTimeoutError)
    })

    it('classifies an oversized error body from its first 4 KiB', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(`{"error":"MalformedCursor","detail":"${'x'.repeat(10_000)}"}`)
      }
      const client = await createClient({ maxPageBytes: 32 })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(MalformedCursorError)
    })

    it('cuts an oversized page body at the cap and surfaces a typed error', async () => {
      const bigBody = JSON.stringify({
        ops: new Array(10_000).fill('x'),
      })
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(bigBody)
      }
      const client = await createClient({ maxPageBytes: 64 })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostResponseTooLargeError)
    })

    it('accepts a page body exactly at the byte cap', async () => {
      const body = JSON.stringify({ ops: [] })
      const client = await createClient({
        maxPageBytes: Buffer.byteLength(body),
      })
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(body)
      }
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).resolves.toEqual({ ops: [], cursor: undefined, commit: undefined })
    })

    it('rejects a page body one byte over the cap', async () => {
      const body = JSON.stringify({ ops: [] })
      const client = await createClient({
        maxPageBytes: Buffer.byteLength(body) - 1,
      })
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(body)
      }
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostResponseTooLargeError)
    })

    it('wraps a body-stream error that is not a cap overrun as SpaceHostUnreachableError', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.write('{"ops":[')
        setImmediate(() => res.destroy())
      }
      const client = await createClient()
      const err = await client
        .listRepoOps({ space: SPACE_URI, repo: REPO_DID })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SpaceHostUnreachableError)
      expect(err).not.toBeInstanceOf(SpaceHostResponseTooLargeError)
      expect((err as Error).cause).toBeDefined()
    })

    it('preserves a fetch error when the caller aborts the request', async () => {
      const controller = new AbortController()
      const abortError = new DOMException('aborted', 'AbortError')
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => ['8.8.8.8'],
        fetch: async () => {
          controller.abort()
          throw abortError
        },
      })

      await expect(
        client.listRepoOps({
          space: SPACE_URI,
          repo: REPO_DID,
          signal: controller.signal,
        }),
      ).rejects.toBe(abortError)
    })

    it('preserves a body error when the caller aborts the request', async () => {
      const controller = new AbortController()
      const abortError = new DOMException('aborted', 'AbortError')
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          controller.abort(abortError)
          stream.error(abortError)
        },
      })
      const client = await createClient({
        hostOrigin: 'https://nerv.example',
        resolveHost: async () => ['8.8.8.8'],
        fetch: async () => new Response(body),
      })

      await expect(
        client.listRepoOps({
          space: SPACE_URI,
          repo: REPO_DID,
          signal: controller.signal,
        }),
      ).rejects.toBe(abortError)
    })

    it('treats a 2xx response with no body as an invalid response, not a crash', async () => {
      mock.handler = (_req, res) => {
        // A null-body status per the fetch spec: `res.body` is `null`, so
        // this exercises the empty-body branch rather than the stream reader.
        res.statusCode = 204
        res.end()
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostInvalidResponseError)
    })

    it('accepts a decoded record exactly at maxRecordBytes despite response framing', async () => {
      const maxRecordBytes = 128
      const value = {
        $type: 'zone.stratos.feed.post',
        text: '',
      }
      const emptyValueBytes = Buffer.byteLength(JSON.stringify(value))
      value.text = 'x'.repeat(maxRecordBytes - emptyValueBytes)
      expect(Buffer.byteLength(JSON.stringify(value))).toBe(maxRecordBytes)
      const body = JSON.stringify({
        uri: 'at://x/y/z',
        cid: 'bafyA',
        value,
      })
      expect(Buffer.byteLength(body)).toBeGreaterThan(maxRecordBytes)

      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(body)
      }
      const client = await createClient({ maxRecordBytes })

      await expect(
        client.getRecord({
          space: SPACE_URI,
          repo: REPO_DID,
          collection: 'zone.stratos.feed.post',
          rkey: 'a1',
        }),
      ).resolves.toEqual({ uri: 'at://x/y/z', cid: 'bafyA', value })
    })

    it('caps getRecord after bounded envelope headroom, independently of maxPageBytes', async () => {
      const maxRecordBytes = 64
      const responseLimit = getRecordResponseByteLimit(maxRecordBytes)
      const bigBody = JSON.stringify({
        uri: 'at://x/y/z',
        cid: 'bafyA',
        value: 'x'.repeat(responseLimit),
      })
      expect(Buffer.byteLength(bigBody)).toBeGreaterThan(responseLimit)
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(bigBody)
      }
      const client = await createClient({
        maxPageBytes: 10_000_000,
        maxRecordBytes,
      })

      const err = await client
        .getRecord({
          space: SPACE_URI,
          repo: REPO_DID,
          collection: 'zone.stratos.feed.post',
          rkey: 'a1',
        })
        .catch((reason: unknown) => reason)

      expect(err).toBeInstanceOf(SpaceHostResponseTooLargeError)
      expect((err as SpaceHostResponseTooLargeError).limitBytes).toBe(
        responseLimit,
      )
    })

    it('fails on a redirect instead of following it', async () => {
      mock.handler = (_req, res) => {
        res.statusCode = 302
        res.setHeader('location', '/elsewhere')
        res.end()
      }
      const client = await createClient()
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(SpaceHostRedirectError)
    })

    it('wraps a connection failure as SpaceHostUnreachableError', async () => {
      const client = new SpaceHostClient({
        // Port 1 is on the fetch spec's forbidden-port list; the request
        // never leaves the local stack, but the failure is indistinguishable
        // from a foreign host that never accepts a connection.
        hostOrigin: 'http://127.0.0.1:1',
        credentialProof: await makeCredentialProof(),
        allowHttpOrigins: new Set(['http://127.0.0.1:1']),
      })
      const err = await client
        .listRepoOps({ space: SPACE_URI, repo: REPO_DID })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SpaceHostUnreachableError)
      expect((err as Error).cause).toBeDefined()
    })

    it('does not let an HTTP exception bypass HTTPS address validation', async () => {
      const fetchImpl = vi.fn<typeof fetch>()
      const client = new SpaceHostClient({
        hostOrigin: 'https://127.0.0.1',
        credentialProof: await makeCredentialProof(),
        allowHttpOrigins: new Set(['https://127.0.0.1']),
        fetch: fetchImpl,
      })

      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(PrivateHostOriginError)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('refuses a plain http origin outside the allowlist before any request leaves the process', async () => {
      mock.handler = (_req, res) => {
        res.end('should never be reached')
      }
      const client = new SpaceHostClient({
        hostOrigin: mock.baseUrl,
        credentialProof: await makeCredentialProof(),
      })
      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(InsecureHostOriginError)
      expect(mock.requests).toHaveLength(0)
    })

    it('refuses an allowlisted remote http origin before creating a presentation proof or sending a request', async () => {
      const credentialProof = await makeCredentialProof()
      const createPresentationProof = vi.spyOn(
        credentialProof,
        'createPresentationProof',
      )
      const fetchImpl = vi.fn<typeof fetch>()
      const client = new SpaceHostClient({
        hostOrigin: 'http://bebop.test',
        credentialProof,
        allowHttpOrigins: new Set(['http://bebop.test']),
        fetch: fetchImpl,
      })

      await expect(
        client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
      ).rejects.toBeInstanceOf(InsecureHostOriginError)
      expect(createPresentationProof).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it.each([
      'http://localhost:3010',
      'http://127.0.0.1:3010',
      'http://[::1]:3010',
    ])(
      'allows an explicit literal-loopback http origin: %s',
      async (origin) => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ ops: [] }), {
            headers: { 'content-type': 'application/json' },
          }),
        )
        const client = new SpaceHostClient({
          hostOrigin: origin,
          credentialProof: await makeCredentialProof(),
          allowHttpOrigins: new Set([origin]),
          fetch: fetchImpl,
        })

        await expect(
          client.listRepoOps({ space: SPACE_URI, repo: REPO_DID }),
        ).resolves.toEqual({ ops: [] })
        expect(fetchImpl).toHaveBeenCalledOnce()
      },
    )

    it('allows a plain http origin explicitly on the allowlist', async () => {
      mock.handler = (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ops: [] }))
      }
      const client = await createClient()
      const result = await client.listRepoOps({
        space: SPACE_URI,
        repo: REPO_DID,
      })
      expect(result.ops).toEqual([])
      expect(mock.requests).toHaveLength(1)
    })
  })
})

describe('space-sync error taxonomy', () => {
  it('names every SpaceHostClientError subclass and carries its url', () => {
    const classes: Array<[new (url: string) => SpaceHostClientError, string]> =
      [
        [InsecureHostOriginError, 'InsecureHostOriginError'],
        [SpaceHostRedirectError, 'SpaceHostRedirectError'],
        [SpaceHostTimeoutError, 'SpaceHostTimeoutError'],
        [SpaceHostUnreachableError, 'SpaceHostUnreachableError'],
      ]
    for (const [ErrorClass, name] of classes) {
      const err = new ErrorClass('https://nerv.example/xrpc/foo')
      expect(err.name).toBe(name)
      expect(err.url).toBe('https://nerv.example/xrpc/foo')
      expect(err).toBeInstanceOf(SpaceHostClientError)
      expect(err).toBeInstanceOf(StratosError)
      expect(err.code).toBe('SpaceHostClientError')
    }
  })

  it('SpaceHostResponseTooLargeError carries the limit that was exceeded', () => {
    const err = new SpaceHostResponseTooLargeError(
      'https://nerv.example/xrpc/foo',
      65_536,
    )
    expect(err.name).toBe('SpaceHostResponseTooLargeError')
    expect(err.limitBytes).toBe(65_536)
  })

  it('MalformedCursorError/RepoNotFoundError/SpaceNotFoundError expose status, body, errorCode, url', () => {
    const err = new RepoNotFoundError({
      status: 400,
      body: JSON.stringify({ error: 'RepoNotFound' }),
      url: 'https://nerv.example/xrpc/com.atproto.space.listRepoOps',
    })
    expect(err.name).toBe('RepoNotFoundError')
    expect(err.status).toBe(400)
    expect(err.errorCode).toBe('RepoNotFound')
    expect(err.url).toBe(
      'https://nerv.example/xrpc/com.atproto.space.listRepoOps',
    )
    expect(err).toBeInstanceOf(SpaceHostRequestError)
    expect(err).toBeInstanceOf(SpaceHostClientError)
  })
})
