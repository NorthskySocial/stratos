import { metrics, type Meter } from '@opentelemetry/api'

/**
 * Late-bound view of the subscription objects. The HTTP server starts before
 * the subscription is wired, so gauges and `/health` read through this mutable
 * holder instead of holding the objects directly.
 */
export interface SubscriptionStatus {
  serviceStream: { isConnected: () => boolean } | null
  actorPool: {
    getStats: () => { active: number; waiting: number; max: number }
  } | null
}

export interface ReconciliationMetrics {
  outcome: 'ok' | 'partial' | 'failed'
  durationSeconds: number
}

export interface SpaceSyncMetrics {
  outcome: 'ok' | 'partial' | 'failed'
  durationSeconds: number
  succeeded: number
  failed: number
  abandoned: number
  skippedMalformed: number
  skippedOversized: number
}

/**
 * Bounded telemetry surface for feedgen. It intentionally exposes operations,
 * not OpenTelemetry instruments, so callers cannot attach user input as an
 * attribute.
 */
export interface FeedgenMetrics {
  beginHttpRequest(): HttpRequestMetrics
  observeFeedRequest(input: {
    outcome: 'ok' | 'expected_error' | 'error'
    postsReturned?: number
  }): void
  recordReconnect(kind: 'service' | 'actor'): void
  recordIndexOperation(
    operation: 'upsert' | 'delete',
    outcome: 'ok' | 'error',
  ): void
  recordBoundaryCache(outcome: 'hit' | 'miss'): void
  recordReconciliation(metrics: ReconciliationMetrics): void
  recordSpaceSync(metrics: SpaceSyncMetrics): void
  recordSpaceSyncTickSkipped(): void
  setReady(ready: boolean): void
}

export interface HttpRequestMetrics {
  complete(input: {
    method: string
    route: string
    status: number
    durationSeconds: number
  }): void
  abort(): void
}

/**
 * Build the feedgen metric set. The Collector receives OTLP and is the sole
 * Prometheus scrape target, so feedgen exposes no Prometheus endpoint.
 */
export function createFeedgenMetrics(
  status: SubscriptionStatus,
  meter: Meter = metrics.getMeter('stratos.feedgen'),
): FeedgenMetrics {
  const httpRequestDuration = meter.createHistogram(
    'http.server.request.duration',
    {
      description: 'Duration of HTTP server requests.',
      unit: 's',
    },
  )
  const activeRequests = meter.createUpDownCounter(
    'http.server.active_requests',
    {
      description: 'HTTP requests currently being served.',
    },
  )
  const feedRequests = meter.createCounter('stratos.feedgen.feed.requests', {
    description: 'Feed requests by bounded outcome.',
  })
  const postsReturned = meter.createHistogram(
    'stratos.feedgen.feed.posts_returned',
    {
      description: 'Posts returned from a feed request.',
      unit: '{posts}',
    },
  )
  const reconnects = meter.createCounter(
    'stratos.feedgen.subscription.reconnects',
    {
      description: 'Scheduled subscription reconnects.',
    },
  )
  const indexOperations = meter.createCounter(
    'stratos.feedgen.index.operations',
    {
      description: 'Local feed index operations.',
    },
  )
  const cacheRequests = meter.createCounter('stratos.feedgen.cache.requests', {
    description: 'Viewer-boundary cache requests.',
  })
  const reconciliationDuration = meter.createHistogram(
    'stratos.feedgen.reconciliation.duration',
    { description: 'Enrollment reconciliation duration.', unit: 's' },
  )
  const reconciliationOutcomes = meter.createCounter(
    'stratos.feedgen.reconciliation.outcomes',
    { description: 'Enrollment reconciliation outcomes.' },
  )
  const spaceSyncDuration = meter.createHistogram(
    'stratos.feedgen.space_sync.duration',
    {
      description: 'Space-sync pass duration.',
      unit: 's',
    },
  )
  const spaceSyncOutcomes = meter.createCounter(
    'stratos.feedgen.space_sync.outcomes',
    {
      description: 'Space-sync pass and member outcomes.',
    },
  )

  let ready = false
  let lastSpaceSyncSuccess = 0
  const heartbeat = meter.createObservableGauge('stratos.telemetry.heartbeat', {
    description: 'Unix timestamp of the latest telemetry observation.',
    unit: 's',
  })
  const readiness = meter.createObservableGauge('stratos.feedgen.ready', {
    description: 'Whether feedgen is ready to serve an authoritative feed.',
  })
  const connected = meter.createObservableGauge(
    'stratos.feedgen.subscription.connected',
    {
      description: 'Whether an authoritative subscription is connected.',
    },
  )
  const actorPool = meter.createObservableGauge('stratos.feedgen.actor_pool', {
    description: 'Actor-pool utilization.',
  })
  const lastSuccess = meter.createObservableGauge(
    'stratos.feedgen.space_sync.last_success',
    {
      description: 'Unix timestamp of the last successful space-sync pass.',
      unit: 's',
    },
  )
  meter.addBatchObservableCallback(
    (result) => {
      result.observe(heartbeat, Date.now() / 1_000)
      result.observe(readiness, ready ? 1 : 0)
      result.observe(connected, status.serviceStream?.isConnected() ? 1 : 0, {
        'stream.kind': 'service',
      })
      const pool = status.actorPool?.getStats()
      result.observe(actorPool, pool?.active ?? 0, { state: 'active' })
      result.observe(actorPool, pool?.waiting ?? 0, { state: 'waiting' })
      result.observe(actorPool, pool?.max ?? 0, { state: 'capacity' })
      if (lastSpaceSyncSuccess > 0)
        result.observe(lastSuccess, lastSpaceSyncSuccess)
    },
    [heartbeat, readiness, connected, actorPool, lastSuccess],
  )

  return {
    beginHttpRequest() {
      activeRequests.add(1)
      return {
        complete({ method, route, status: responseStatus, durationSeconds }) {
          const attributes = {
            'http.request.method': method,
            'http.route': route,
            'http.response.status_code': responseStatus,
          }
          activeRequests.add(-1)
          httpRequestDuration.record(durationSeconds, attributes)
        },
        abort() {
          activeRequests.add(-1)
        },
      }
    },
    observeFeedRequest({ outcome, postsReturned: count }) {
      feedRequests.add(1, { outcome })
      if (count !== undefined) postsReturned.record(count)
    },
    recordReconnect(kind) {
      reconnects.add(1, { 'stream.kind': kind })
    },
    recordIndexOperation(operation, outcome) {
      indexOperations.add(1, { operation, outcome })
    },
    recordBoundaryCache(outcome) {
      cacheRequests.add(1, { outcome })
    },
    recordReconciliation({ outcome, durationSeconds }) {
      reconciliationDuration.record(durationSeconds, { outcome })
      reconciliationOutcomes.add(1, { outcome })
    },
    recordSpaceSync({
      outcome,
      durationSeconds,
      succeeded,
      failed,
      abandoned,
      skippedMalformed,
      skippedOversized,
    }) {
      spaceSyncDuration.record(durationSeconds, { outcome })
      spaceSyncOutcomes.add(1, { outcome: 'pass' })
      if (succeeded) spaceSyncOutcomes.add(succeeded, { outcome: 'member_ok' })
      if (failed) spaceSyncOutcomes.add(failed, { outcome: 'member_error' })
      if (abandoned)
        spaceSyncOutcomes.add(abandoned, { outcome: 'member_abandoned' })
      if (skippedMalformed)
        spaceSyncOutcomes.add(skippedMalformed, {
          outcome: 'skipped_malformed',
        })
      if (skippedOversized)
        spaceSyncOutcomes.add(skippedOversized, {
          outcome: 'skipped_oversized',
        })
      if (outcome === 'ok') lastSpaceSyncSuccess = Date.now() / 1_000
    },
    recordSpaceSyncTickSkipped() {
      spaceSyncOutcomes.add(1, { outcome: 'tick_skipped' })
    },
    setReady(value) {
      ready = value
    },
  }
}
