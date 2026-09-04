import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'

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
import {
  createMeterProvider,
  BACKGROUND_BUCKETS_SECONDS,
  HTTP_BUCKETS_SECONDS,
  parseTelemetryConfig,
} from '../src/observability/runtime.js'

const FEEDGEN_DID = 'did:web:feedgen.tokyo3.test'
const VIEWER_DID = 'did:plc:shinjiikari'

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

describe('OTLP metrics', () => {
  let ctx: TestServerCtx | undefined

  afterEach(async () => {
    if (ctx) await stopServer(ctx)
    ctx = undefined
  })

  it('does not expose a public Prometheus scrape endpoint', async () => {
    ctx = await startServer()
    expect((await fetch(`${ctx.baseUrl}/metrics`)).status).toBe(404)
  })

  it('exports bounded metric names and attributes through its supplied meter', async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = createMeterProvider(
      parseTelemetryConfig(
        {
          HOSTNAME: 'feedgen-observability-test',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
            'http://collector:4318/v1/metrics',
        },
        'stratos-feedgen',
      ),
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      }),
    )
    const status: SubscriptionStatus = { serviceStream: null, actorPool: null }
    const metrics = createFeedgenMetrics(
      status,
      provider.getMeter('feedgen-test'),
    )

    const request = metrics.beginHttpRequest()
    request.complete({
      method: 'GET',
      route: '/xrpc/zone.stratos.feedgen.getFeed',
      status: 200,
      durationSeconds: 0.125,
    })
    metrics.observeFeedRequest({ outcome: 'ok', postsReturned: 2 })
    metrics.recordReconnect('service')
    metrics.recordIndexOperation('upsert', 'ok')
    metrics.recordBoundaryCache('hit')
    metrics.recordReconciliation({ outcome: 'ok', durationSeconds: 0.25 })
    metrics.recordSpaceSync({
      outcome: 'partial',
      durationSeconds: 0.5,
      succeeded: 1,
      failed: 1,
      abandoned: 0,
      skippedMalformed: 0,
      skippedOversized: 0,
    })
    await provider.forceFlush()

    const exported = exporter.getMetrics()
    const metricNames = exported
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name)
    expect(metricNames).toEqual(
      expect.arrayContaining([
        'http.server.request.duration',
        'http.server.active_requests',
        'stratos.feedgen.feed.requests',
        'stratos.feedgen.subscription.reconnects',
        'stratos.feedgen.index.operations',
        'stratos.feedgen.cache.requests',
        'stratos.feedgen.reconciliation.duration',
        'stratos.feedgen.space_sync.duration',
      ]),
    )
    const http = exported
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find(
        (metric) => metric.descriptor.name === 'http.server.request.duration',
      )
    expect(http?.descriptor.unit).toBe('s')
    expect(
      (http?.dataPoints[0]?.value as { buckets: { boundaries: number[] } })
        .buckets.boundaries,
    ).toEqual(HTTP_BUCKETS_SECONDS)
    expect(http?.dataPoints[0]?.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/xrpc/zone.stratos.feedgen.getFeed',
      'http.response.status_code': 200,
    })
    expect(exported[0]?.resource.attributes).toMatchObject({
      'service.name': 'stratos-feedgen',
      'service.instance.id': 'feedgen-observability-test',
    })
    const reconciliation = exported
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find(
        (metric) =>
          metric.descriptor.name === 'stratos.feedgen.reconciliation.duration',
      )
    expect(
      (
        reconciliation?.dataPoints[0]?.value as {
          buckets: { boundaries: number[] }
        }
      ).buckets.boundaries,
    ).toEqual(BACKGROUND_BUCKETS_SECONDS)
    await provider.shutdown()
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

  it('SubscriptionIndexer reports every projected post mutation', async () => {
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

    expect(onPostIndexed).toHaveBeenNthCalledWith(1, 'upsert')
    expect(onPostIndexed).toHaveBeenNthCalledWith(2, 'upsert')
    expect(onPostIndexed).toHaveBeenNthCalledWith(3, 'delete')
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
