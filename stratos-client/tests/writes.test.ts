import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  applyBoundaryWrites,
  boundaryToSpaceUri,
  BoundaryWriteError,
  createBoundaryRecord,
  deleteBoundaryRecord,
  putBoundaryRecord,
  resolveRepositoryTarget,
  ScopeUpgradeRequiredError,
  type BoundaryWriteClient,
  type FetchHandler,
  type RepositoryTarget,
} from '../src'

interface CapturedRequest {
  method: string
  path: string
  contentType: string | undefined
  authorization: string | undefined
  body: unknown
}

const MEMBER_DID = 'did:plc:shinji1stunit'
const SERVICE_DID = 'did:web:nerv.example'
const BOUNDARY = `${SERVICE_DID}/geofront`
const SPACE_URI = `at://${SERVICE_DID}/space/zone.stratos.space.feed/geofront`
const POST_COLLECTION = 'zone.stratos.feed.post'
const POST = {
  $type: POST_COLLECTION,
  text: 'Get in the robot',
  createdAt: 'x',
}

let server: Server
let origin: string
let captured: CapturedRequest[] = []
let reply: { status: number; body: unknown } = { status: 200, body: {} }

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      captured.push({
        method: req.method ?? '',
        path: req.url ?? '',
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()))
})

afterEach(() => {
  captured = []
  reply = { status: 200, body: {} }
})

const authenticatedHandler: FetchHandler = (url, init) => {
  const headers = new Headers(init?.headers)
  headers.set('authorization', 'DPoP test-token')
  return fetch(url, { ...init, headers })
}

const clientFor = (target: RepositoryTarget): BoundaryWriteClient => ({
  handler: authenticatedHandler,
  resolveTarget: () => target,
})

const stratosClient = () => clientFor({ kind: 'stratos', url: origin })
const pdsClient = () => clientFor({ kind: 'pds', url: origin })

const WRITE_CASES = [
  {
    name: 'createBoundaryRecord',
    call: (client: BoundaryWriteClient) =>
      createBoundaryRecord(client, {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: '3kasumi',
        validate: false,
        record: POST,
      }),
    stratos: {
      nsid: 'zone.stratos.repo.createRecord',
      body: {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: '3kasumi',
        validate: false,
        record: POST,
      },
    },
    pds: {
      nsid: 'com.atproto.space.createRecord',
      body: {
        space: SPACE_URI,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: '3kasumi',
        validate: false,
        record: POST,
      },
    },
    response: { uri: 'at://x/y/z', cid: 'bafycid' },
  },
  {
    name: 'putBoundaryRecord',
    call: (client: BoundaryWriteClient) =>
      putBoundaryRecord(client, {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: '3kasumi',
        record: POST,
      }),
    stratos: {
      nsid: 'zone.stratos.repo.putRecord',
      body: {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: '3kasumi',
        record: POST,
      },
    },
    pds: {
      nsid: 'com.atproto.space.putRecord',
      body: {
        space: SPACE_URI,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: '3kasumi',
        record: POST,
      },
    },
    response: { uri: 'at://x/y/z', cid: 'bafycid' },
  },
  {
    name: 'deleteBoundaryRecord',
    call: (client: BoundaryWriteClient) =>
      deleteBoundaryRecord(client, {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        collection: 'app.bsky.feed.like',
        rkey: '3misato',
      }),
    stratos: {
      nsid: 'zone.stratos.repo.deleteRecord',
      body: {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        collection: 'app.bsky.feed.like',
        rkey: '3misato',
      },
    },
    pds: {
      nsid: 'com.atproto.space.deleteRecord',
      body: {
        space: SPACE_URI,
        repo: MEMBER_DID,
        collection: 'app.bsky.feed.like',
        rkey: '3misato',
      },
    },
    response: {},
  },
  {
    name: 'applyBoundaryWrites',
    call: (client: BoundaryWriteClient) =>
      applyBoundaryWrites(client, {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        validate: true,
        writes: [
          { action: 'create', collection: POST_COLLECTION, value: POST },
          {
            action: 'update',
            collection: POST_COLLECTION,
            rkey: '3asuka',
            value: POST,
          },
          { action: 'delete', collection: POST_COLLECTION, rkey: '3rei' },
        ],
      }),
    stratos: {
      nsid: 'zone.stratos.repo.applyWrites',
      body: {
        boundary: BOUNDARY,
        repo: MEMBER_DID,
        validate: true,
        writes: [
          {
            $type: 'zone.stratos.repo.applyWrites#create',
            collection: POST_COLLECTION,
            value: POST,
          },
          {
            $type: 'zone.stratos.repo.applyWrites#update',
            collection: POST_COLLECTION,
            rkey: '3asuka',
            value: POST,
          },
          {
            $type: 'zone.stratos.repo.applyWrites#delete',
            collection: POST_COLLECTION,
            rkey: '3rei',
          },
        ],
      },
    },
    pds: {
      nsid: 'com.atproto.space.applyWrites',
      body: {
        space: SPACE_URI,
        repo: MEMBER_DID,
        validate: true,
        writes: [
          {
            $type: 'com.atproto.space.applyWrites#create',
            collection: POST_COLLECTION,
            value: POST,
          },
          {
            $type: 'com.atproto.space.applyWrites#update',
            collection: POST_COLLECTION,
            rkey: '3asuka',
            value: POST,
          },
          {
            $type: 'com.atproto.space.applyWrites#delete',
            collection: POST_COLLECTION,
            rkey: '3rei',
          },
        ],
      },
    },
    response: {
      results: [{ $type: 'zone.stratos.repo.applyWrites#deleteResult' }],
    },
  },
]

describe('boundary write helpers', () => {
  describe.each(WRITE_CASES)('$name', (writeCase) => {
    it('stratos custody posts the zone.stratos.repo procedure with the boundary', async () => {
      reply = { status: 200, body: writeCase.response }

      const result = await writeCase.call(stratosClient())

      expect(result).toEqual({ ok: true, value: writeCase.response })
      expect(captured).toEqual([
        {
          method: 'POST',
          path: `/xrpc/${writeCase.stratos.nsid}`,
          contentType: 'application/json',
          authorization: 'DPoP test-token',
          body: writeCase.stratos.body,
        },
      ])
    })

    it('pds custody posts the com.atproto.space procedure with the space URI', async () => {
      reply = { status: 200, body: writeCase.response }

      const result = await writeCase.call(pdsClient())

      expect(result).toEqual({ ok: true, value: writeCase.response })
      expect(captured).toEqual([
        {
          method: 'POST',
          path: `/xrpc/${writeCase.pds.nsid}`,
          contentType: 'application/json',
          authorization: 'DPoP test-token',
          body: writeCase.pds.body,
        },
      ])
    })

    it('sends nothing and returns the reason when the target is unresolved', async () => {
      const unresolved = resolveRepositoryTarget(null, {})

      const result = await writeCase.call(clientFor(unresolved))

      expect(result).toEqual({ ok: false, reason: 'missing-enrollment' })
      expect(captured).toEqual([])
    })

    it('throws a typed error when the member must authorize again', async () => {
      reply = {
        status: 400,
        body: {
          error: 'ScopeUpgradeRequired',
          message: "The member's grant predates this collection.",
        },
      }

      const failure = await writeCase.call(stratosClient()).catch((e) => e)

      expect(failure).toBeInstanceOf(ScopeUpgradeRequiredError)
      expect(failure).toBeInstanceOf(BoundaryWriteError)
      expect(failure.status).toBe(400)
      expect(failure.errorName).toBe('ScopeUpgradeRequired')
    })

    it('throws the service error name for any other failure', async () => {
      reply = {
        status: 400,
        body: { error: 'BoundaryMismatch', message: 'wrong boundary' },
      }

      const failure = await writeCase.call(stratosClient()).catch((e) => e)

      expect(failure).toBeInstanceOf(BoundaryWriteError)
      expect(failure).not.toBeInstanceOf(ScopeUpgradeRequiredError)
      expect(failure.errorName).toBe('BoundaryMismatch')
      expect(failure.message).toBe('wrong boundary')
    })
  })

  it('refuses a pds write for a boundary it cannot turn into a space URI', async () => {
    const result = await createBoundaryRecord(pdsClient(), {
      boundary: 'no-slash-here',
      repo: MEMBER_DID,
      collection: POST_COLLECTION,
      record: POST,
    })

    expect(result).toEqual({ ok: false, reason: 'invalid-boundary' })
    expect(captured).toEqual([])
  })

  it('leaves boundary validation to the service for stratos custody', async () => {
    reply = { status: 200, body: { uri: 'u', cid: 'c' } }

    await createBoundaryRecord(stratosClient(), {
      boundary: 'no-slash-here',
      repo: MEMBER_DID,
      collection: POST_COLLECTION,
      record: POST,
    })

    expect(captured).toHaveLength(1)
    expect((captured[0].body as { boundary: string }).boundary).toBe(
      'no-slash-here',
    )
  })
})

const SKEY_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~:-'
const DID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-'

/** Seeded so a failure reproduces; stratos-client has no property-test library. */
const seededPicker = (seed: number) => {
  let state = seed
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % limit
  }
}

const randomString = (
  pick: (limit: number) => number,
  alphabet: string,
  maxLength: number,
) =>
  Array.from(
    { length: 1 + pick(maxLength) },
    () => alphabet[pick(alphabet.length)],
  ).join('')

describe('pds space URI', () => {
  it('is the boundary with the hosted space type for arbitrary valid boundaries', async () => {
    const pick = seededPicker(1995)
    for (let run = 0; run < 40; run += 1) {
      const did = `did:web:${randomString(pick, DID_ALPHABET, 20)}`
      const skey = `s${randomString(pick, SKEY_ALPHABET, 60)}`
      captured = []
      reply = { status: 200, body: { uri: 'u', cid: 'c' } }

      await putBoundaryRecord(pdsClient(), {
        boundary: `${did}/${skey}`,
        repo: MEMBER_DID,
        collection: POST_COLLECTION,
        rkey: 'k',
        record: POST,
      })

      const space = (captured[0].body as { space: string }).space
      const match = /^at:\/\/([^/]+)\/space\/([^/]+)\/([^/]+)$/.exec(space)
      expect(match, space).not.toBeNull()
      expect(`${match![1]}/${match![3]}`).toBe(`${did}/${skey}`)
      expect(match![2]).toBe('zone.stratos.space.feed')
    }
  })

  it('rejects boundaries that are not a service DID and a record-key name', () => {
    for (const boundary of [
      '',
      'geofront',
      '/geofront',
      `${SERVICE_DID}/`,
      `${SERVICE_DID}/..`,
      `${SERVICE_DID}/.`,
      `${SERVICE_DID}/a/b`,
      `${SERVICE_DID}/has space`,
      `not-a-did/geofront`,
      `did:web:/geofront`,
      `did:WEB:nerv/geofront`,
      `did:web:nerv:/geofront`,
    ]) {
      expect(
        boundaryToSpaceUri(boundary, 'zone.stratos.space.feed').ok,
        boundary,
      ).toBe(false)
    }
  })
})
