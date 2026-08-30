import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client'

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

export interface FeedgenMetrics {
  registry: Registry
  requestsTotal: Counter<'endpoint' | 'status'>
  requestDuration: Histogram<'endpoint'>
  reconnectsTotal: Counter<'kind'>
  indexPostsTotal: Counter
  boundaryCacheHits: Counter
  boundaryCacheMisses: Counter
}

/**
 * Build the feedgen metric set on a dedicated registry. A dedicated registry
 * keeps tests isolated and avoids double-registration under vitest reloads.
 */
export function createFeedgenMetrics(
  status: SubscriptionStatus,
): FeedgenMetrics {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })

  const requestsTotal = new Counter({
    name: 'feedgen_requests_total',
    help: 'HTTP requests served, by endpoint and response status.',
    labelNames: ['endpoint', 'status'],
    registers: [registry],
  })

  const requestDuration = new Histogram({
    name: 'feedgen_request_duration_seconds',
    help: 'HTTP request duration in seconds, by endpoint.',
    labelNames: ['endpoint'],
    registers: [registry],
  })

  new Gauge({
    name: 'feedgen_subscriptions_open',
    help: 'Open sync subscriptions, by kind (service stream, actor syncers).',
    labelNames: ['kind'],
    registers: [registry],
    collect() {
      this.set({ kind: 'service' }, status.serviceStream?.isConnected() ? 1 : 0)
      this.set({ kind: 'actor' }, status.actorPool?.getStats().active ?? 0)
    },
  })

  const reconnectsTotal = new Counter({
    name: 'feedgen_subscription_reconnects_total',
    help: 'Sync subscription reconnect attempts scheduled, by kind.',
    labelNames: ['kind'],
    registers: [registry],
  })

  const indexPostsTotal = new Counter({
    name: 'feedgen_index_posts_total',
    help: 'Posts upserted into the local index.',
    registers: [registry],
  })

  const boundaryCacheHits = new Counter({
    name: 'feedgen_boundary_cache_hits_total',
    help: 'Viewer boundary cache hits.',
    registers: [registry],
  })

  const boundaryCacheMisses = new Counter({
    name: 'feedgen_boundary_cache_misses_total',
    help: 'Viewer boundary cache misses (fresh upstream fetches).',
    registers: [registry],
  })

  return {
    registry,
    requestsTotal,
    requestDuration,
    reconnectsTotal,
    indexPostsTotal,
    boundaryCacheHits,
    boundaryCacheMisses,
  }
}
