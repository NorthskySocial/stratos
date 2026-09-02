import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildFeedRegistry,
  createFeedgenServer,
  type FeedRequestVerifier,
  type IndexedPost,
  type ListPostsOpts,
  type ListPostsResult,
} from '../src/index.js'

const FEEDGEN_DID = 'did:web:feedgen.spiegelcorp.test'
const VIEWER_DID = 'did:plc:spikespiegel'
const FAYE_DID = 'did:plc:fayevalentine'

interface TestServerCtx {
  httpServer: HttpServer
  baseUrl: string
  listPosts: ReturnType<
    typeof vi.fn<(opts: ListPostsOpts) => Promise<ListPostsResult>>
  >
  resolveBoundaries: ReturnType<
    typeof vi.fn<(did: string) => Promise<string[]>>
  >
  verifier: ReturnType<typeof vi.fn> & FeedRequestVerifier
}

async function startServer(opts?: {
  viewerBoundaries?: string[]
  posts?: IndexedPost[]
  nextCursor?: string
  readiness?: { isReady(): boolean }
  /** Override verifier to simulate auth failure or alternative viewer DIDs. */
  verifier?: FeedRequestVerifier
}): Promise<TestServerCtx> {
  const viewerBoundaries = opts?.viewerBoundaries ?? ['engineering']
  const posts = opts?.posts ?? []

  const listPosts = vi.fn(
    async (_opts: ListPostsOpts): Promise<ListPostsResult> => ({
      posts,
      cursor: opts?.nextCursor,
    }),
  )

  const resolveBoundaries = vi.fn(async (_did: string) => viewerBoundaries)

  const defaultVerifier: FeedRequestVerifier = async () => ({
    viewerDid: VIEWER_DID,
    lxm: 'zone.stratos.feedgen.getFeed',
  })
  const verifier = vi.fn(opts?.verifier ?? defaultVerifier) as ReturnType<
    typeof vi.fn
  > &
    FeedRequestVerifier

  const feeds = buildFeedRegistry([
    {
      id: 'eng-feed',
      boundary: 'engineering',
      displayName: 'Engineering',
      description: 'Posts in engineering',
    },
    { id: 'leadership-feed', boundary: 'leadership' },
  ])

  const server = createFeedgenServer({
    feedgenServiceDid: FEEDGEN_DID,
    feedgenPublicUrl: 'https://feedgen.spiegelcorp.test',
    publicKeyMultibase: 'zQ3shFakeMultibaseForTests',
    feeds,
    store: {
      listPostsByBoundary: listPosts,
    } as unknown as Parameters<typeof createFeedgenServer>[0]['store'],
    enrollmentManager: {
      getBoundaries: resolveBoundaries,
    } as unknown as Parameters<
      typeof createFeedgenServer
    >[0]['enrollmentManager'],
    verifier,
    feedReadiness: opts?.readiness,
  })

  const httpServer = await server.listen(0, '127.0.0.1')
  const addr = httpServer.address() as AddressInfo
  return {
    httpServer,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    listPosts,
    resolveBoundaries,
    verifier,
  }
}

async function stopServer(ctx: TestServerCtx): Promise<void> {
  await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()))
}

function makePost(uri: string, did: string, sortAt: string): IndexedPost {
  return {
    uri,
    did,
    cid: 'bafyreigh2akiscaildc' + uri.slice(-8),
    sortAt,
    indexedAt: sortAt,
    record: {
      $type: 'zone.stratos.feed.post',
      text: 'hello',
      createdAt: sortAt,
    },
    blobRefs: [],
    boundaries: ['engineering'],
  }
}

describe('zone.stratos.feedgen.getFeed', () => {
  let ctx: TestServerCtx | undefined

  afterEach(async () => {
    if (ctx) await stopServer(ctx)
    ctx = undefined
  })

  it('returns an empty feed when the boundary has no posts', async () => {
    ctx = await startServer()

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { feed: unknown[]; cursor?: string }
    expect(body).toEqual({ feed: [] })
    expect(ctx.verifier).toHaveBeenCalledOnce()
    expect(ctx.resolveBoundaries).toHaveBeenCalledWith(VIEWER_DID)
    expect(ctx.listPosts).toHaveBeenCalledWith({
      boundary: 'engineering',
      limit: 50,
      cursor: undefined,
    })
  })

  it('fails closed while replay authorization is not ready', async () => {
    ctx = await startServer({
      readiness: { isReady: () => false },
      posts: [
        makePost(
          'at://did:plc:fayevalentine/zone.stratos.feed.post/1',
          FAYE_DID,
          '2025-01-01T00:00:00.000Z',
        ),
      ],
    })

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('FeedNotReady')
    expect(ctx.resolveBoundaries).not.toHaveBeenCalled()
    expect(ctx.listPosts).not.toHaveBeenCalled()
  })

  it('fails closed if readiness changes during a feed read', async () => {
    const readiness = {
      isReady: vi
        .fn<() => boolean>()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
    }
    ctx = await startServer({ readiness })

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(503)
    expect(ctx.listPosts).toHaveBeenCalledOnce()
  })

  it('returns hydrated feedViewPosts with cursor', async () => {
    const posts = [
      makePost(
        'at://did:plc:spikespiegel/zone.stratos.feed.post/1',
        VIEWER_DID,
        '2025-01-01T00:00:00.000Z',
      ),
      makePost(
        'at://did:plc:fayevalentine/zone.stratos.feed.post/2',
        FAYE_DID,
        '2025-01-01T00:01:00.000Z',
      ),
    ]
    ctx = await startServer({ posts, nextCursor: 'next' })

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed&limit=10`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cursor?: string
      feed: Array<{
        post: { uri: string; author: { did: string }; boundaries: string[] }
      }>
    }
    expect(body.cursor).toBe('next')
    expect(body.feed).toHaveLength(2)
    expect(body.feed[0]?.post.uri).toBe(posts[0]?.uri)
    expect(body.feed[0]?.post.author.did).toBe(VIEWER_DID)
    expect(body.feed[0]?.post.boundaries).toEqual(['engineering'])
    expect(body.feed[1]?.post.author.did).toBe(FAYE_DID)
    expect(ctx.listPosts).toHaveBeenCalledWith({
      boundary: 'engineering',
      limit: 10,
      cursor: undefined,
    })
  })

  it('returns a permissioned space record URI', async () => {
    const post = makePost(
      'at://did:web:feedgen.spiegelcorp.test/space/zone.stratos.space.feed/engineering/did:plc:fayevalentine/zone.stratos.feed.post/1',
      FAYE_DID,
      '2025-01-01T00:01:00.000Z',
    )
    ctx = await startServer({ posts: [post] })

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      feed: Array<{ post: { uri: string; author: { did: string } } }>
    }
    expect(body.feed[0]?.post.uri).toBe(post.uri)
    expect(body.feed[0]?.post.author.did).toBe(FAYE_DID)
  })

  it('rejects unknown feed ids with UnknownFeed', async () => {
    ctx = await startServer()

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=nope`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('UnknownFeed')
    expect(ctx.listPosts).not.toHaveBeenCalled()
  })

  it('rejects with BoundaryMismatch when viewer lacks the feed boundary', async () => {
    ctx = await startServer({ viewerBoundaries: ['marketing'] })

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('BoundaryMismatch')
    expect(ctx.listPosts).not.toHaveBeenCalled()
  })

  it('rejects requests without an Authorization header', async () => {
    ctx = await startServer({
      verifier: async () => {
        const { AuthRequiredError } = await import('@atproto/xrpc-server')
        throw new AuthRequiredError('missing auth', 'AuthMissing')
      },
    })

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed`,
    )

    expect(res.status).toBe(401)
    expect(ctx.listPosts).not.toHaveBeenCalled()
  })

  it('passes cursor through to the store when valid', async () => {
    ctx = await startServer()
    const cursor = '2025-01-01T00:00:00.000Z::at://did:plc:x/post/1'

    await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed&cursor=${encodeURIComponent(cursor)}`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(ctx.listPosts).toHaveBeenCalledWith({
      boundary: 'engineering',
      limit: 50,
      cursor,
    })
  })

  it('drops malformed cursors', async () => {
    ctx = await startServer()

    await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed&cursor=not-valid`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(ctx.listPosts).toHaveBeenCalledWith({
      boundary: 'engineering',
      limit: 50,
      cursor: undefined,
    })
  })

  it('clamps limit above the lexicon max', async () => {
    ctx = await startServer()

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=eng-feed&limit=500`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    // The lexicon enforces max=100 at the parameter layer, so an out-of-range
    // value yields an InvalidRequest before our handler runs.
    expect(res.status).toBe(400)
    expect(ctx.listPosts).not.toHaveBeenCalled()
  })
})

describe('/health', () => {
  let ctx: TestServerCtx | undefined

  afterEach(async () => {
    if (ctx) await stopServer(ctx)
    ctx = undefined
  })

  it('returns ok + version', async () => {
    ctx = await startServer()
    const res = await fetch(`${ctx.baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
  })
})
