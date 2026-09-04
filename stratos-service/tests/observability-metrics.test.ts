import { describe, expect, it } from 'vitest'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  createServiceMetrics,
  normalizeServiceRoute,
} from '../src/observability/metrics.js'
import {
  createMeterProvider,
  BACKGROUND_BUCKETS_SECONDS,
  HTTP_BUCKETS_SECONDS,
  parseTelemetryConfig,
} from '../src/observability/runtime.js'

describe('service observability metrics', () => {
  it('normalizes untrusted paths to a bounded route vocabulary', () => {
    expect(normalizeServiceRoute('/xrpc/com.atproto.repo.createRecord')).toBe(
      '/xrpc/com.atproto.repo.createRecord',
    )
    expect(normalizeServiceRoute('/xrpc/example.attacker.generated')).toBe(
      '/xrpc/:nsid',
    )
    expect(normalizeServiceRoute('/records/did:plc:shinji')).toBe('unknown')
    expect(normalizeServiceRoute('/boundaries/status')).toBe(
      '/oauth/boundaries/status',
    )
  })

  it('exports service operational metrics through its supplied meter', async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const provider = createMeterProvider(
      parseTelemetryConfig(
        {
          HOSTNAME: 'service-observability-test',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
            'http://collector:4318/v1/metrics',
        },
        'stratos-service',
      ),
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      }),
    )
    const metrics = createServiceMetrics(provider.getMeter('service-test'))

    const request = metrics.beginHttpRequest()
    request.complete({
      method: 'POST',
      route: '/xrpc/com.atproto.repo.createRecord',
      status: 200,
      durationSeconds: 0.125,
    })
    metrics.recordAuth('ok')
    metrics.recordAuth('rejected')
    metrics.recordAuth('error')
    metrics.recordRecordOperation('create', 'ok')
    metrics.recordRecordOperation('delete', 'error')
    metrics.recordRecordOperation('batch', 'ok')
    metrics.recordPdsSyncAttempt('retry')
    metrics.recordPdsSyncAttempt('ok')
    metrics.recordPdsSyncAttempt('failed')
    metrics.setPdsSyncQueue({
      pending: 3,
      failed: 2,
      oldestPendingAgeSeconds: 42,
    })
    metrics.setReady(true)
    metrics.recordSyncConnection('service', true)
    metrics.recordSyncConnection('service', false)
    metrics.recordSyncConnection('actor', true)
    metrics.recordSyncConnection('actor', false)
    metrics.recordSyncEvent('applied')
    metrics.recordSyncEvent('dropped')
    metrics.recordLockWait(0.01, true)
    metrics.recordLockWait(0, false)
    metrics.setLockWaiters(2)
    metrics.recordStorageOperation('sqlite', 'write', 'ok', 0.01)
    metrics.recordStorageOperation('postgres', 'read', 'error', 0.02)
    metrics.recordStorageOperation('disk', 'delete', 'ok', 0.03)
    metrics.recordStorageOperation('s3', 'write', 'error', 0.04)
    await provider.forceFlush()

    const exported = exporter.getMetrics()
    const names = exported
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'http.server.request.duration',
        'http.server.active_requests',
        'stratos.service.auth.requests',
        'stratos.service.record.operations',
        'stratos.service.pds_sync.attempts',
        'stratos.service.sync.connections',
        'stratos.service.sync.events',
        'stratos.service.repo.lock.wait.duration',
        'stratos.storage.operation.duration',
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
      'http.request.method': 'POST',
      'http.route': '/xrpc/com.atproto.repo.createRecord',
      'http.response.status_code': 200,
    })
    expect(exported[0]?.resource.attributes).toMatchObject({
      'service.name': 'stratos-service',
      'service.instance.id': 'service-observability-test',
    })
    const lockWait = exported
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find(
        (metric) =>
          metric.descriptor.name === 'stratos.service.repo.lock.wait.duration',
      )
    expect(
      (lockWait?.dataPoints[0]?.value as { buckets: { boundaries: number[] } })
        .buckets.boundaries,
    ).toEqual(BACKGROUND_BUCKETS_SECONDS)
    const metric = (name: string) =>
      exported
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .find((item) => item.descriptor.name === name)
    const gaugePoints = (name: string) =>
      metric(name)?.dataPoints.map((point) => ({
        attributes: point.attributes,
        value: point.value,
      }))

    expect(metric('http.server.active_requests')?.descriptor).toMatchObject({
      description: 'HTTP requests currently being served.',
    })
    expect(
      metric('http.server.active_requests')?.dataPoints.reduce(
        (total, point) => total + Number(point.value),
        0,
      ),
    ).toBe(0)
    expect(metric('stratos.telemetry.heartbeat')?.descriptor).toMatchObject({
      description: 'Unix timestamp of the latest telemetry observation.',
      unit: 's',
    })
    expect(metric('stratos.service.ready')?.descriptor).toMatchObject({
      description: 'Whether the service has started and can accept requests.',
    })
    expect(
      metric('stratos.service.pds_sync.queue.jobs')?.descriptor,
    ).toMatchObject({
      description: 'Pending and terminal PDS enrollment-sync jobs.',
    })
    expect(
      metric('stratos.service.pds_sync.queue.oldest_age')?.descriptor,
    ).toMatchObject({
      description: 'Age of the oldest pending PDS enrollment-sync job.',
      unit: 's',
    })
    expect(
      metric('stratos.service.repo.lock.waiters')?.descriptor,
    ).toMatchObject({ description: 'Repository write-lock waiters.' })
    expect(gaugePoints('stratos.service.ready')).toEqual([
      { attributes: {}, value: 1 },
    ])
    expect(gaugePoints('stratos.service.pds_sync.queue.jobs')).toEqual(
      expect.arrayContaining([
        { attributes: { state: 'pending' }, value: 3 },
        { attributes: { state: 'failed' }, value: 2 },
      ]),
    )
    expect(gaugePoints('stratos.service.pds_sync.queue.oldest_age')).toEqual([
      { attributes: {}, value: 42 },
    ])
    expect(gaugePoints('stratos.service.repo.lock.waiters')).toEqual([
      { attributes: {}, value: 2 },
    ])
    expect(
      metric('stratos.service.auth.requests')?.dataPoints.map(
        (point) => point.attributes,
      ),
    ).toEqual(
      expect.arrayContaining([
        { outcome: 'ok' },
        { outcome: 'rejected' },
        { outcome: 'error' },
      ]),
    )
    expect(
      metric('stratos.storage.operations')?.dataPoints.map(
        (point) => point.attributes,
      ),
    ).toEqual(
      expect.arrayContaining([
        { 'storage.backend': 'sqlite', operation: 'write', outcome: 'ok' },
        { 'storage.backend': 'postgres', operation: 'read', outcome: 'error' },
        { 'storage.backend': 'disk', operation: 'delete', outcome: 'ok' },
        { 'storage.backend': 's3', operation: 'write', outcome: 'error' },
      ]),
    )
    await provider.shutdown()
  })
})
