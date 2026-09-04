import { metrics, type Meter } from '@opentelemetry/api'

export interface PdsSyncQueueStats {
  pending: number
  failed: number
  oldestPendingAgeSeconds: number
}

const KNOWN_XRPC_NSIDS = new Set([
  'com.atproto.repo.applyWrites',
  'com.atproto.repo.createRecord',
  'com.atproto.repo.deleteRecord',
  'com.atproto.repo.getRecord',
  'com.atproto.repo.listRecords',
  'com.atproto.sync.getBlob',
  'zone.stratos.enrollment.status',
  'zone.stratos.enrollment.resolveEnrollments',
  'zone.stratos.repo.hydrateRecord',
  'zone.stratos.repo.hydrateRecords',
  'zone.stratos.space.getRecord',
  'zone.stratos.space.getSpaceCredential',
  'zone.stratos.sync.getBlob',
  'zone.stratos.sync.listRecordPaths',
  'zone.stratos.sync.listRepoOps',
])

/** Collapse input paths to a small stable route vocabulary. */
export function normalizeServiceRoute(path: string): string {
  if (KNOWN_HTTP_ROUTES.has(path)) return path
  if (path.startsWith('/xrpc/')) {
    const nsid = path.slice('/xrpc/'.length)
    return KNOWN_XRPC_NSIDS.has(nsid) ? `/xrpc/${nsid}` : '/xrpc/:nsid'
  }
  if (path.startsWith('/oauth/')) return '/oauth/:route'
  if (path.startsWith('/admin/')) return '/admin/:route'
  return 'unknown'
}

const KNOWN_HTTP_ROUTES = new Set([
  '/',
  '/health',
  '/ready',
  '/.well-known/did.json',
  '/oauth/boundaries',
  '/oauth/boundaries/status',
  '/oauth/boundaries/post',
])

/**
 * Application-owned metric methods. These accept only bounded attributes so
 * an operator cannot accidentally turn an untrusted request value into a time
 * series label.
 */
export interface ServiceMetrics {
  beginHttpRequest(): HttpRequestMetrics
  setReady(ready: boolean): void
  recordAuth(outcome: 'ok' | 'rejected' | 'error'): void
  recordRecordOperation(
    operation: 'create' | 'update' | 'delete' | 'batch',
    outcome: 'ok' | 'error',
  ): void
  recordPdsSyncAttempt(outcome: 'ok' | 'retry' | 'failed'): void
  setPdsSyncQueue(stats: PdsSyncQueueStats): void
  recordSyncConnection(kind: 'service' | 'actor', connected: boolean): void
  recordSyncEvent(outcome: 'applied' | 'dropped'): void
  recordLockWait(seconds: number, waited: boolean): void
  setLockWaiters(waiters: number): void
  recordStorageOperation(
    backend: 'sqlite' | 'postgres' | 'disk' | 's3',
    operation: 'read' | 'write' | 'delete',
    outcome: 'ok' | 'error',
    durationSeconds: number,
  ): void
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

export function createServiceMetrics(
  meter: Meter = metrics.getMeter('stratos.service'),
): ServiceMetrics {
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
  const authRequests = meter.createCounter('stratos.service.auth.requests', {
    description: 'Authentication outcomes.',
  })
  const recordOperations = meter.createCounter(
    'stratos.service.record.operations',
    {
      description: 'Record write operations.',
    },
  )
  const pdsSyncAttempts = meter.createCounter(
    'stratos.service.pds_sync.attempts',
    {
      description: 'PDS enrollment-sync attempts.',
    },
  )
  const syncConnections = meter.createUpDownCounter(
    'stratos.service.sync.connections',
    {
      description: 'Open synchronization connections.',
    },
  )
  const syncEvents = meter.createCounter('stratos.service.sync.events', {
    description: 'Synchronization event outcomes.',
  })
  const lockWaitDuration = meter.createHistogram(
    'stratos.service.repo.lock.wait.duration',
    {
      description: 'Time spent waiting for a repository write lock.',
      unit: 's',
    },
  )
  const storageDuration = meter.createHistogram(
    'stratos.storage.operation.duration',
    {
      description: 'Storage operation duration.',
      unit: 's',
    },
  )
  const storageOperations = meter.createCounter('stratos.storage.operations', {
    description: 'Storage operations.',
  })

  let ready = false
  let queue: PdsSyncQueueStats = {
    pending: 0,
    failed: 0,
    oldestPendingAgeSeconds: 0,
  }
  let lockWaiters = 0
  const heartbeat = meter.createObservableGauge('stratos.telemetry.heartbeat', {
    description: 'Unix timestamp of the latest telemetry observation.',
    unit: 's',
  })
  const readiness = meter.createObservableGauge('stratos.service.ready', {
    description: 'Whether the service has started and can accept requests.',
  })
  const pendingJobs = meter.createObservableGauge(
    'stratos.service.pds_sync.queue.jobs',
    {
      description: 'Pending and terminal PDS enrollment-sync jobs.',
    },
  )
  const oldestPendingAge = meter.createObservableGauge(
    'stratos.service.pds_sync.queue.oldest_age',
    {
      description: 'Age of the oldest pending PDS enrollment-sync job.',
      unit: 's',
    },
  )
  const waiters = meter.createObservableGauge(
    'stratos.service.repo.lock.waiters',
    {
      description: 'Repository write-lock waiters.',
    },
  )
  meter.addBatchObservableCallback(
    (result) => {
      result.observe(heartbeat, Date.now() / 1_000)
      result.observe(readiness, ready ? 1 : 0)
      result.observe(pendingJobs, queue.pending, { state: 'pending' })
      result.observe(pendingJobs, queue.failed, { state: 'failed' })
      result.observe(oldestPendingAge, queue.oldestPendingAgeSeconds)
      result.observe(waiters, lockWaiters)
    },
    [heartbeat, readiness, pendingJobs, oldestPendingAge, waiters],
  )

  return {
    beginHttpRequest() {
      activeRequests.add(1)
      return {
        complete({ method, route, status, durationSeconds }) {
          activeRequests.add(-1)
          httpRequestDuration.record(durationSeconds, {
            'http.request.method': method,
            'http.route': route,
            'http.response.status_code': status,
          })
        },
        abort() {
          activeRequests.add(-1)
        },
      }
    },
    setReady(value) {
      ready = value
    },
    recordAuth(outcome) {
      authRequests.add(1, { outcome })
    },
    recordRecordOperation(operation, outcome) {
      recordOperations.add(1, { operation, outcome })
    },
    recordPdsSyncAttempt(outcome) {
      pdsSyncAttempts.add(1, { outcome })
    },
    setPdsSyncQueue(stats) {
      queue = stats
    },
    recordSyncConnection(kind, connected) {
      syncConnections.add(connected ? 1 : -1, { 'stream.kind': kind })
    },
    recordSyncEvent(outcome) {
      syncEvents.add(1, { outcome })
    },
    recordLockWait(seconds, waited) {
      lockWaitDuration.record(seconds, {
        outcome: waited ? 'waited' : 'immediate',
      })
    },
    setLockWaiters(value) {
      lockWaiters = value
    },
    recordStorageOperation(backend, operation, outcome, durationSeconds) {
      const attributes = { 'storage.backend': backend, operation, outcome }
      storageDuration.record(durationSeconds, attributes)
      storageOperations.add(1, attributes)
    },
  }
}

export const serviceMetrics = createServiceMetrics()
