import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { AtUri } from '@atproto/syntax'
import { Lexicons } from '@atproto/lexicon'
import { Secp256k1Keypair } from '@atproto/crypto'
import { decodeAll } from '@atproto/lex-cbor'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  type BoundarySettings,
  computeCid,
  encodeRecord,
  parseCid,
  stratosLexicons,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context.js'
import {
  applyBoundaryWrites,
  createRecord,
  deleteRecord,
} from '../src/api/records/index.js'
import { createRepoManager } from '../src/api/records/util.js'
import { createSubscribeAuthVerifier } from '../src/infra/auth/verifiers.js'
import {
  MAX_COMMIT_FRAME_BYTES,
  registerSubscribeRecords,
} from '../src/subscription/index.js'
import {
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

// The Rust feed generator parses the same file in its conformance tests, so
// the two sides cannot drift apart unnoticed. Set WRITE_ACTOR_FRAME_FIXTURE=1
// to regenerate it from real subscriber traffic, then run prettier on it.
const FIXTURE_URL = new URL(
  '../../stratos-feedgen/testdata/conformance/v1/actor-commit-frames.json',
  import.meta.url,
)
const REGENERATE = process.env.WRITE_ACTOR_FRAME_FIXTURE === '1'

const SERVICE_DID = HARNESS_SERVICE_DID
const TOKYO3_NAME = 'tokyo-3'
const GEOFRONT_NAME = 'geofront'
const TOKYO3 = `${SERVICE_DID}/${TOKYO3_NAME}`
const GEOFRONT = `${SERVICE_DID}/${GEOFRONT_NAME}`
const COLLECTION = 'zone.stratos.feed.post'
const ACTOR_DID = 'did:plc:misato-katsuragi'
const SUBSCRIBER_DID = 'did:web:geofront.tokyo.jp'
const SUBSCRIBE_METHOD = 'zone.stratos.sync.subscribeRecords'
const FRAME_TIMEOUT_MS = 10_000

function openBoundarySettings(displayName: string): BoundarySettings {
  return {
    displayName,
    description: '',
    listed: false,
    joinable: false,
    autoEnroll: false,
    appAccess: 'open',
    clientIds: [],
  }
}

const uriOf = (rkey: string) => `at://${ACTOR_DID}/${COLLECTION}/${rkey}`

interface ExpectedProjection {
  upserts: Array<{ uri: string; boundaries: string[] }>
  deletes: string[]
}

interface FixtureCase {
  name: string
  serviceDid: string
  actorDid: string
  authorizedBoundaries: string[]
  frameBase64: string
  expected: ExpectedProjection
}

interface ActorFrameFixture {
  version: number
  cases: FixtureCase[]
}

interface FrameOp {
  action: string
  path: string
  boundary?: unknown
  record?: unknown
}

const LIKE_COLLECTION = 'app.bsky.feed.like'
const REPOST_COLLECTION = 'app.bsky.feed.repost'

// A case that is not a post write names its action, since a feed generator
// reading only posts finds no change in it.
const EXPECTED: Array<{
  name: string
  expected: ExpectedProjection
  action?: 'create' | 'delete'
}> = [
  {
    name: 'a legacy create whose body and operation boundaries agree',
    expected: {
      upserts: [{ uri: uriOf('sachiel'), boundaries: [TOKYO3] }],
      deletes: [],
    },
  },
  {
    name: 'a post with no body boundary and an operation boundary',
    expected: {
      upserts: [{ uri: uriOf('shamshel'), boundaries: [GEOFRONT] }],
      deletes: [],
    },
  },
  {
    name: 'a post whose body claims one boundary and whose operation names another',
    expected: {
      upserts: [{ uri: uriOf('ramiel'), boundaries: [GEOFRONT] }],
      deletes: [],
    },
  },
  {
    name: 'a legacy delete of the first record',
    expected: { upserts: [], deletes: [uriOf('sachiel')] },
  },
  {
    name: 'a post written through the boundary create procedure with no body boundary',
    expected: {
      upserts: [{ uri: uriOf('gaghiel'), boundaries: [GEOFRONT] }],
      deletes: [],
    },
  },
  {
    name: 'a like of a post, written through the generic write procedures',
    expected: { upserts: [], deletes: [] },
    action: 'create',
  },
  {
    name: 'a repost of a post, written through the generic write procedures',
    expected: { upserts: [], deletes: [] },
    action: 'create',
  },
  {
    name: 'a delete of the like',
    expected: { upserts: [], deletes: [] },
    action: 'delete',
  },
]

function countActions(cases: typeof EXPECTED) {
  let creates = 0
  let deletes = 0
  for (const { expected, action } of cases) {
    const isDelete = action === 'delete' || expected.deletes.length > 0
    if (isDelete) deletes += 1
    else creates += 1
  }
  return { creates, deletes }
}

function postBody(text: string, boundaries: string[]) {
  const body: Record<string, unknown> = {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
  }
  if (boundaries.length > 0) {
    body.boundary = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    }
  }
  return body
}

function didDocumentFor(keypair: Secp256k1Keypair) {
  return {
    id: keypair.did(),
    verificationMethod: [
      {
        id: `${keypair.did()}#key`,
        type: 'Multikey',
        controller: keypair.did(),
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
  }
}

function decodeFrame(frame: Uint8Array) {
  const [header, body, ...rest] = [...decodeAll(frame)] as [
    { t?: string },
    Record<string, unknown>,
    ...unknown[],
  ]
  expect(rest).toEqual([])
  return { header, body }
}

// The service sends an op's cid as text while the lexicon declares a cid-link,
// so the rest of the frame is validated with the cid parsed.
function withCidLink(op: FrameOp & { cid?: unknown }) {
  return typeof op.cid === 'string' ? { ...op, cid: parseCid(op.cid) } : op
}

function opsOf(frame: Uint8Array): FrameOp[] {
  const ops = (decodeFrame(frame).body.ops ?? []) as FrameOp[]
  return ops.map(({ action, path, boundary, record }) => ({
    action,
    path,
    boundary,
    record,
  }))
}

describe('the shared actor commit frame fixture', () => {
  let harness: WriteHarness
  let actorStore: AppContext['actorStore']
  let ctx: AppContext
  let subscriberKey: Secp256k1Keypair
  let httpServer: http.Server

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    ctx = harness.ctx
    actorStore = ctx.actorStore

    for (const name of [TOKYO3_NAME, GEOFRONT_NAME]) {
      await ctx.boundaryManager!.create(name, openBoundarySettings(name))
    }
    await harness.enrollMember(ACTOR_DID, [TOKYO3, GEOFRONT])
    await harness.enrollServiceIdentity(SUBSCRIBER_DID, [TOKYO3, GEOFRONT])

    subscriberKey = await Secp256k1Keypair.create()
    const didCache = new MemoryCache()
    await didCache.cacheDid(SUBSCRIBER_DID, didDocumentFor(subscriberKey))
    const subscriberIdResolver = new IdResolver({ didCache })

    const subscribeCtx = {
      ...ctx,
      xrpcServer: new XrpcServer(stratosLexicons),
      authVerifier: {
        ...ctx.authVerifier,
        subscribeAuth: createSubscribeAuthVerifier(
          subscriberIdResolver,
          SERVICE_DID,
        ),
      },
    } as AppContext
    registerSubscribeRecords(subscribeCtx)
    const app = express()
    app.use(subscribeCtx.xrpcServer.router)
    httpServer = app.listen(0)
  })

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
    await harness.close()
  })

  // Writes the way the generic write procedures will: the authority hands the
  // boundary to the repo manager and the record body may say anything.
  async function writeWithOperationBoundary(
    rkey: string,
    body: Record<string, unknown>,
    boundary: string,
  ) {
    const actorSign = await ctx.actorSigner.getSignFn(ACTOR_DID)
    const cid = await computeCid(body)
    await actorStore.transact(ACTOR_DID, async (store) => {
      const manager = createRepoManager(ctx.logger, store, actorSign, {})
      const writeResult = await manager.applyWrites(
        ACTOR_DID,
        [
          {
            action: 'create',
            collection: COLLECTION,
            rkey,
            record: body,
            cid,
            boundary,
          },
        ],
        store.repo,
        [{ cid, bytes: encodeRecord(body) }],
      )
      await store.record.indexRecordInBoundary(
        AtUri.make(ACTOR_DID, COLLECTION, rkey).toString(),
        cid,
        body,
        boundary,
        'create',
        writeResult.rev,
      )
    })
  }

  async function writeTheCases() {
    await createRecord(
      ctx,
      {
        repo: ACTOR_DID,
        collection: COLLECTION,
        rkey: 'sachiel',
        record: postBody('Sachiel', [TOKYO3]),
      },
      ACTOR_DID,
    )
    await writeWithOperationBoundary(
      'shamshel',
      postBody('Shamshel', []),
      GEOFRONT,
    )
    await writeWithOperationBoundary(
      'ramiel',
      postBody('Ramiel', [TOKYO3]),
      GEOFRONT,
    )
    await deleteRecord(
      ctx,
      { repo: ACTOR_DID, collection: COLLECTION, rkey: 'sachiel' },
      ACTOR_DID,
    )
    const gaghiel = await applyBoundaryWrites(ctx, ACTOR_DID, GEOFRONT, [
      {
        kind: 'create',
        collection: COLLECTION,
        rkey: 'gaghiel',
        record: postBody('Gaghiel', []),
      },
    ])
    const subject = { uri: uriOf('gaghiel'), cid: gaghiel.results[0].cid }
    for (const [collection, rkey] of [
      [LIKE_COLLECTION, 'rei-like'],
      [REPOST_COLLECTION, 'asuka-repost'],
    ]) {
      await applyBoundaryWrites(ctx, ACTOR_DID, GEOFRONT, [
        {
          kind: 'create',
          collection,
          rkey,
          record: {
            $type: collection,
            subject,
            createdAt: '1996-10-04T00:00:00.000Z',
          },
        },
      ])
    }
    await applyBoundaryWrites(ctx, ACTOR_DID, GEOFRONT, [
      { kind: 'delete', collection: LIKE_COLLECTION, rkey: 'rei-like' },
    ])
  }

  async function receiveRawFrames(): Promise<Uint8Array[]> {
    const { port } = httpServer.address() as { port: number }
    const jwt = await createServiceJwt({
      iss: SUBSCRIBER_DID,
      aud: SERVICE_DID,
      lxm: SUBSCRIBE_METHOD,
      keypair: subscriberKey,
    })
    const url = `ws://127.0.0.1:${port}/xrpc/${SUBSCRIBE_METHOD}?did=${encodeURIComponent(ACTOR_DID)}&cursor=0`
    return new Promise((resolve, reject) => {
      const received: Uint8Array[] = []
      const socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${jwt}` },
      })
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error('timed out waiting for the commit frames'))
      }, FRAME_TIMEOUT_MS)
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return
        const frame = new Uint8Array(data)
        // Cursor 0 draws an #info notice ahead of the commits; only commits
        // are actor frames.
        if (decodeFrame(frame).header.t !== '#commit') return
        received.push(frame)
        if (received.length === EXPECTED.length) {
          clearTimeout(timer)
          socket.close()
          resolve(received)
        }
      })
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  function readFixture(): ActorFrameFixture {
    return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as ActorFrameFixture
  }

  it('matches the frames the subscribe route sends for each case', async () => {
    await writeTheCases()
    const frames = await receiveRawFrames()
    expect(frames).toHaveLength(EXPECTED.length)

    const produced: ActorFrameFixture = {
      version: 1,
      cases: EXPECTED.map(({ name, expected }, index) => ({
        name,
        serviceDid: SERVICE_DID,
        actorDid: ACTOR_DID,
        authorizedBoundaries: [TOKYO3, GEOFRONT],
        frameBase64: Buffer.from(frames[index]).toString('base64'),
        expected,
      })),
    }

    if (REGENERATE) {
      writeFileSync(FIXTURE_URL, `${JSON.stringify(produced, null, 2)}\n`)
    }

    const lexicons = new Lexicons(stratosLexicons)
    const fixture = readFixture()
    expect(fixture.version).toBe(1)
    expect(fixture.cases).toHaveLength(EXPECTED.length)
    fixture.cases.forEach((pinned, index) => {
      const live = produced.cases[index]
      expect(pinned.name).toBe(live.name)
      expect(pinned.serviceDid).toBe(live.serviceDid)
      expect(pinned.actorDid).toBe(live.actorDid)
      expect(pinned.authorizedBoundaries).toEqual(live.authorizedBoundaries)
      expect(pinned.expected).toEqual(live.expected)

      const pinnedBytes = Buffer.from(pinned.frameBase64, 'base64')
      expect(pinnedBytes.length).toBeLessThanOrEqual(MAX_COMMIT_FRAME_BYTES)
      expect(frames[index].length).toBeLessThanOrEqual(MAX_COMMIT_FRAME_BYTES)
      // Bytes, CIDs, revisions and times differ between runs; the shape each
      // consumer reads does not.
      expect(opsOf(frames[index])).toEqual(opsOf(pinnedBytes))

      const { header, body } = decodeFrame(frames[index])
      lexicons.assertValidXrpcMessage(SUBSCRIBE_METHOD, {
        ...body,
        ops: (body.ops as FrameOp[]).map((op) => withCidLink(op)),
        $type: `${SUBSCRIBE_METHOD}${header.t}`,
      })
    })
  })

  // Once the service and the lexicon agree on the op cid, this test and the
  // converted-cid helper above go away and every frame is validated as sent.
  it('create frames carry the op cid as text, not as the cid-link the lexicon declares', async () => {
    await writeTheCases()
    const frames = await receiveRawFrames()
    expect(frames).toHaveLength(EXPECTED.length)
    const lexicons = new Lexicons(stratosLexicons)
    const validate = (frame: Uint8Array) => {
      const { header, body } = decodeFrame(frame)
      lexicons.assertValidXrpcMessage(SUBSCRIBE_METHOD, {
        ...body,
        $type: `${SUBSCRIBE_METHOD}${header.t}`,
      })
    }

    let creates = 0
    let deletes = 0
    for (const frame of frames) {
      const [op] = opsOf(frame)
      if (op.action === 'create') {
        creates += 1
        expect(() => validate(frame)).toThrow(/cid/)
      } else {
        deletes += 1
        expect(() => validate(frame)).not.toThrow()
      }
    }
    expect({ creates, deletes }).toEqual(countActions(EXPECTED))
  })
})
