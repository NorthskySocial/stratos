import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ActorSyncer,
  buildFeedRegistry,
  createFeedgenMetrics,
  createFeedgenServer,
  EnrollmentManager,
  type FeedgenMetrics,
  type FeedRequestVerifier,
  type IndexedPost,
  ServiceStream,
  SubscriptionIndexer,
  type SubscriptionStatus,
  type UpstreamStratosClient,
} from '../src/index.js'
import type { FeedgenStore } from '../src/db/index.js'

const FEEDGEN_DID = 'did:web:feedgen.tokyo3.test'
const VIEWER_DID = 'did:plc:shinjiikari'

const ISSUE_METRIC_NAMES = [
  'feedgen_requests_total',
  'feedgen_request_duration_seconds',
  'feedgen_subscriptions_open',
  'feedgen_subscription_reconnects_total',
  'feedgen_index_posts_total',
  'feedgen_boundary_cache_hits_total',
  'feedgen_boundary_cache_misses_total',
]

interface TestServerCtx {
  httpServer: HttpServer
  baseUrl: string
  metrics: FeedgenMetrics
  status: SubscriptionStatus
}

async function startServer(): Promise<TestServerCtx> {
  const status: SubscriptionStatus = { serviceStream: null, actorPool: null }
  const metrics = createFeedgenMetrics(status)

  const verifier: FeedRequestVerifier = async () => ({
    viewerDid: VIEWER_DID,
    lxm: 'zone.stratos.feedgen.getFeed',
  })

  const feeds = buildFeedRegistry([{ id: 'nerv-feed', boundary: 'nerv' }])

  const server = createFeedgenServer({
    feedgenServiceDid: FEEDGEN_DID,
    feedgenPublicUrl: 'https://feedgen.tokyo3.test',
    publicKeyMultibase: 'zQ3shFakeMultibaseForTests',
    feeds,
    store: {
      listPostsByBoundary: async (): Promise<{
        posts: IndexedPost[]
        cursor?: string
      }> => ({ posts: [] }),
    } as unknown as Parameters<typeof createFeedgenServer>[0]['store'],
    enrollmentManager: {
      getBoundaries: async () => ['nerv'],
    } as unknown as Parameters<
      typeof createFeedgenServer
    >[0]['enrollmentManager'],
    verifier,
    metrics,
    subscriptionStatus: status,
  })

  const httpServer = await server.listen(0, '127.0.0.1')
  const addr = httpServer.address() as AddressInfo
  return {
    httpServer,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    metrics,
    status,
  }
}

async function stopServer(ctx: TestServerCtx): Promise<void> {
  await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()))
}

async function scrape(ctx: TestServerCtx): Promise<Response> {
  return fetch(`${ctx.baseUrl}/metrics`)
}

const SAMPLE_LINE =
  /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? (?:[0-9.eE+-]+|NaN)( [0-9]+)?$/

function sampleName(line: string): string {
  const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line)
  return match?.[1] ?? ''
}

describe('/metrics endpoint', () => {
  let ctx: TestServerCtx | undefined

  afterEach(async () => {
    if (ctx) await stopServer(ctx)
    ctx = undefined
  })

  it('serves valid Prometheus text format with every issue metric', async () => {
    ctx = await startServer()
    await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=nerv-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )
    await fetch(`${ctx.baseUrl}/xrpc/zone.stratos.feedgen.describeFeed`)
    await fetch(`${ctx.baseUrl}/no-such-route`)

    const res = await scrape(ctx)
    expect(res.status).toBe(200)
    // Express may reorder the parameters; assert the tokens, not the order.
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/plain')
    expect(contentType).toContain('version=0.0.4')

    const body = await res.text()
    const lines = body.split('\n').filter((l) => l.length > 0)
    const typedNames = new Set<string>()
    for (const line of lines) {
      if (line.startsWith('# TYPE ')) {
        typedNames.add(line.split(' ')[2] ?? '')
        continue
      }
      if (line.startsWith('#')) continue
      expect(line).toMatch(SAMPLE_LINE)
      const name = sampleName(line)
      const base = name.replace(/_(bucket|sum|count)$/, '')
      // A `# TYPE` line must precede the samples it describes.
      expect(typedNames.has(name) || typedNames.has(base)).toBe(true)
    }
    for (const name of ISSUE_METRIC_NAMES) {
      expect(typedNames.has(name)).toBe(true)
    }
  })

  it('counts requests per endpoint/status and observes durations', async () => {
    ctx = await startServer()
    await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=nerv-feed`,
      { headers: { authorization: 'Bearer test-token' } },
    )
    await fetch(`${ctx.baseUrl}/no-such-route`)

    const body = await (await scrape(ctx)).text()
    expect(body).toContain(
      'feedgen_requests_total{endpoint="/xrpc/zone.stratos.feedgen.getFeed",status="200"} 1',
    )
    // Unknown paths collapse to one label value (bounded cardinality).
    expect(body).toContain(
      'feedgen_requests_total{endpoint="unknown",status="404"} 1',
    )
    const countLine = body
      .split('\n')
      .find((l) =>
        l.startsWith(
          'feedgen_request_duration_seconds_count{endpoint="/xrpc/zone.stratos.feedgen.getFeed"}',
        ),
      )
    expect(countLine).toBeDefined()
    expect(Number(countLine?.split(' ')[1])).toBeGreaterThanOrEqual(1)
    // Durations are observed in seconds, not milliseconds.
    const sumLine = body
      .split('\n')
      .find((l) =>
        l.startsWith(
          'feedgen_request_duration_seconds_sum{endpoint="/xrpc/zone.stratos.feedgen.getFeed"}',
        ),
      )
    expect(Number(sumLine?.split(' ')[1])).toBeGreaterThanOrEqual(0)
    expect(Number(sumLine?.split(' ')[1])).toBeLessThan(60)
  })

  it('serves labeled reconnect counter samples', async () => {
    ctx = await startServer()
    ctx.metrics.reconnectsTotal.inc({ kind: 'service' })

    const body = await (await scrape(ctx)).text()
    expect(body).toContain(
      'feedgen_subscription_reconnects_total{kind="service"} 1',
    )
  })

  it('reports subscription state on /health from the late-bound status', async () => {
    ctx = await startServer()

    let health = await (await fetch(`${ctx.baseUrl}/health`)).json()
    expect(health).toMatchObject({
      ok: true,
      serviceStreamConnected: false,
      actorPoolSize: 0,
    })

    ctx.status.serviceStream = { isConnected: () => true }
    ctx.status.actorPool = {
      getStats: () => ({ active: 3, waiting: 1, max: 500 }),
    }
    health = await (await fetch(`${ctx.baseUrl}/health`)).json()
    expect(health).toMatchObject({
      serviceStreamConnected: true,
      actorPoolSize: 3,
    })
  })

  it('reports subscription gauges from the late-bound status', async () => {
    ctx = await startServer()

    let body = await (await scrape(ctx)).text()
    expect(body).toContain('feedgen_subscriptions_open{kind="service"} 0')
    expect(body).toContain('feedgen_subscriptions_open{kind="actor"} 0')

    ctx.status.serviceStream = { isConnected: () => true }
    ctx.status.actorPool = {
      getStats: () => ({ active: 3, waiting: 1, max: 500 }),
    }
    body = await (await scrape(ctx)).text()
    expect(body).toContain('feedgen_subscriptions_open{kind="service"} 1')
    expect(body).toContain('feedgen_subscriptions_open{kind="actor"} 3')
  })
})

describe('metric hooks', () => {
  it('ServiceStream fires onReconnectScheduled when the socket cannot be built', async () => {
    const onReconnectScheduled = vi.fn()
    class ThrowingWs {
      constructor() {
        throw new Error('connection refused')
      }
    }
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.tokyo3.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000_000,
        onReconnectScheduled,
      },
      {
        onEnroll: () => {},
        onUnenroll: () => {},
      },
      undefined,
      { wsCtor: ThrowingWs as never },
    )
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    stream.stop()
    expect(onReconnectScheduled).toHaveBeenCalledTimes(1)
  })

  it('ActorSyncer fires onReconnectScheduled when the socket cannot be built', async () => {
    const onReconnectScheduled = vi.fn()
    class ThrowingWs {
      constructor() {
        throw new Error('connection refused')
      }
    }
    const syncer = new ActorSyncer(
      {
        did: 'did:plc:asukalangley',
        stratosServiceUrl: 'http://stratos.tokyo3.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000_000,
        onReconnectScheduled,
      },
      {
        store: { getCursor: async () => null },
        indexer: {} as SubscriptionIndexer,
        wsCtor: ThrowingWs as never,
      },
    )
    syncer.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    syncer.stop()
    expect(onReconnectScheduled).toHaveBeenCalledTimes(1)
  })

  it('EnrollmentManager reports a miss for a fresh fetch and a hit afterwards', async () => {
    const events: string[] = []
    const manager = new EnrollmentManager({
      client: {
        resolveEnrollments: async () => ({
          enrolled: true,
          boundaries: ['nerv'],
        }),
      } as unknown as Pick<UpstreamStratosClient, 'resolveEnrollments'>,
      onCacheEvent: (event) => events.push(event),
    })

    await manager.getBoundaries('did:plc:reiayanami')
    await manager.getBoundaries('did:plc:reiayanami')
    expect(events).toEqual(['miss', 'hit'])
  })

  it('EnrollmentManager counts joining an in-flight fetch as neither hit nor miss', async () => {
    const events: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const manager = new EnrollmentManager({
      client: {
        resolveEnrollments: async () => {
          await gate
          return { enrolled: true, boundaries: ['nerv'] }
        },
      } as unknown as Pick<UpstreamStratosClient, 'resolveEnrollments'>,
      onCacheEvent: (event) => events.push(event),
    })

    const first = manager.getBoundaries('did:plc:misatokatsuragi')
    const second = manager.getBoundaries('did:plc:misatokatsuragi')
    release?.()
    await Promise.all([first, second])
    expect(events).toEqual(['miss'])
  })

  it('SubscriptionIndexer fires onPostIndexed once per upserted post', async () => {
    const onPostIndexed = vi.fn()
    const store = {
      upsertPost: vi.fn(async () => {}),
      deletePost: vi.fn(async () => {}),
      upsertCursor: vi.fn(async () => {}),
    } as unknown as FeedgenStore
    const indexer = new SubscriptionIndexer(store, { onPostIndexed })

    await indexer.applyCommit({
      did: 'did:plc:spikespiegel',
      seq: 7,
      time: '2024-01-01T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/bebop1',
          cid: 'bafy1',
          record: { $type: 'zone.stratos.feed.post', text: 'jazz' },
        },
        {
          action: 'create',
          path: 'zone.stratos.feed.post/bebop2',
          cid: 'bafy2',
          record: { $type: 'zone.stratos.feed.post', text: 'blues' },
        },
        { action: 'delete', path: 'zone.stratos.feed.post/bebop3' },
      ],
    })

    expect(onPostIndexed).toHaveBeenCalledTimes(2)
  })

  it('SubscriptionIndexer indexes with a hooks object that has no onPostIndexed', async () => {
    const store = {
      upsertPost: vi.fn(async () => {}),
      deletePost: vi.fn(async () => {}),
      upsertCursor: vi.fn(async () => {}),
    } as unknown as FeedgenStore
    const indexer = new SubscriptionIndexer(store, {})

    await indexer.applyCommit({
      did: 'did:plc:fayevalentine',
      seq: 8,
      time: '2024-01-01T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/bebop4',
          cid: 'bafy4',
          record: { $type: 'zone.stratos.feed.post', text: 'poker' },
        },
      ],
    })

    expect(store.upsertPost).toHaveBeenCalledTimes(1)
  })
})
