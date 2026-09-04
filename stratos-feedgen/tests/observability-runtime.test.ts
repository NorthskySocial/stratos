import { describe, expect, it } from 'vitest'
import {
  parseTelemetryConfig,
  scrubEvent,
} from '../src/observability/runtime.js'

describe('feedgen telemetry runtime', () => {
  it('uses bounded defaults when exporters are disabled', () => {
    const config = parseTelemetryConfig({}, 'stratos-feedgen')

    expect(config.metricsEndpoint).toBeUndefined()
    expect(config.metricExportInterval).toBe(15_000)
    expect(config.sentryTracesSampleRate).toBe(1)
    expect(config.resourceAttributes).toMatchObject({
      'service.name': 'stratos-feedgen',
      'service.namespace': 'northsky',
      'deployment.environment.name': 'development',
    })
  })

  it('validates exporter inputs and applies production sampling', () => {
    expect(() =>
      parseTelemetryConfig(
        { SENTRY_TRACES_SAMPLE_RATE: '-1' },
        'stratos-feedgen',
      ),
    ).toThrow('SENTRY_TRACES_SAMPLE_RATE')
    expect(() =>
      parseTelemetryConfig(
        { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'not-a-url' },
        'stratos-feedgen',
      ),
    ).toThrow('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT')
    expect(
      parseTelemetryConfig(
        { SENTRY_ENVIRONMENT: 'production' },
        'stratos-feedgen',
      ).sentryTracesSampleRate,
    ).toBe(0.2)
  })

  it('accepts both sample-rate bounds and rejects invalid export intervals', () => {
    expect(
      parseTelemetryConfig(
        { SENTRY_TRACES_SAMPLE_RATE: '0' },
        'stratos-feedgen',
      ).sentryTracesSampleRate,
    ).toBe(0)
    expect(
      parseTelemetryConfig(
        { SENTRY_TRACES_SAMPLE_RATE: '1' },
        'stratos-feedgen',
      ).sentryTracesSampleRate,
    ).toBe(1)
    expect(() =>
      parseTelemetryConfig(
        { OTEL_METRIC_EXPORT_INTERVAL: '0' },
        'stratos-feedgen',
      ),
    ).toThrow('OTEL_METRIC_EXPORT_INTERVAL')
    expect(() =>
      parseTelemetryConfig(
        { OTEL_METRIC_EXPORT_INTERVAL: '1.5' },
        'stratos-feedgen',
      ),
    ).toThrow('OTEL_METRIC_EXPORT_INTERVAL')
  })

  it('normalizes values and preserves valid resource attributes', () => {
    const config = parseTelemetryConfig(
      {
        SENTRY_RELEASE: 'cowboy-1',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
          ' https://otel.example/v1/metrics ',
        OTEL_METRIC_EXPORT_INTERVAL: '20000',
        OTEL_RESOURCE_ATTRIBUTES: 'region=solar, crew= bebop ',
      },
      'stratos-feedgen',
    )

    expect(config.metricsEndpoint).toBe('https://otel.example/v1/metrics')
    expect(config.metricExportInterval).toBe(20_000)
    expect(config.resourceAttributes).toMatchObject({
      region: 'solar',
      crew: ' bebop',
      'service.version': 'cowboy-1',
    })
    expect(() =>
      parseTelemetryConfig(
        { OTEL_RESOURCE_ATTRIBUTES: 'not-an-attribute' },
        'stratos-feedgen',
      ),
    ).toThrow('OTEL_RESOURCE_ATTRIBUTES')
  })

  it('removes sensitive fields while retaining operational context', () => {
    expect(
      scrubEvent({
        contexts: { actor: { did: 'did:plc:spike' } },
        request: { headers: { cookie: 'session' }, oauth: { state: 'state' } },
      }),
    ).toEqual({
      contexts: { actor: { did: 'did:plc:spike' } },
      request: { headers: { cookie: '[Filtered]' }, oauth: '[Filtered]' },
    })
  })

  it('scrubs sensitive values nested in arrays', () => {
    expect(scrubEvent({ breadcrumbs: [{ token: 'red-tail' }] })).toEqual({
      breadcrumbs: [{ token: '[Filtered]' }],
    })
  })

  it('redacts sensitive URL query values before export', () => {
    expect(
      scrubEvent({
        request: {
          url: 'https://feedgen.example/oauth/callback?code=asuka&state=unit-02&scope=feed',
          query_string: 'code=asuka&state=unit-02',
        },
      }),
    ).toEqual({
      request: {
        url: 'https://feedgen.example/oauth/callback?code=%5BFiltered%5D&state=%5BFiltered%5D&scope=feed',
        query_string: '[Filtered]',
      },
    })
  })
})
