import * as Sentry from '@sentry/node'
import { metrics } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  AggregationType,
  createAllowListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'

const SECRET =
  /authorization|cookie|dpop|token|secret|password|body|post|oauth|code|state/i
export const HTTP_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]
export const BACKGROUND_BUCKETS_SECONDS = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
]
export const METRIC_ATTRIBUTE_KEYS = [
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'operation',
  'outcome',
  'custody',
  'stream.kind',
  'storage.backend',
  'room.id',
  'state',
]
let telemetry: { shutdown(): Promise<void> } = { shutdown: async () => {} }

export interface TelemetryConfig {
  sentryDsn?: string
  sentryEnvironment?: string
  sentryRelease?: string
  sentryTracesSampleRate?: number
  metricsEndpoint?: string
  metricExportInterval: number
  resourceAttributes: Record<string, string>
}

export function parseTelemetryConfig(
  env: NodeJS.ProcessEnv,
  serviceName: string,
): TelemetryConfig {
  const rate = value(env.SENTRY_TRACES_SAMPLE_RATE)
  const environment = value(env.SENTRY_ENVIRONMENT) ?? 'development'
  const sentryTracesSampleRate =
    rate === undefined ? defaultSampleRate(environment) : Number(rate)
  if (
    sentryTracesSampleRate !== undefined &&
    (!Number.isFinite(sentryTracesSampleRate) ||
      sentryTracesSampleRate < 0 ||
      sentryTracesSampleRate > 1)
  ) {
    throw new Error('SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1')
  }

  const metricsEndpoint = value(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
  if (metricsEndpoint) {
    try {
      new URL(metricsEndpoint)
    } catch {
      throw new Error('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT must be a valid URL')
    }
  }

  const interval = value(env.OTEL_METRIC_EXPORT_INTERVAL)
  const metricExportInterval =
    interval === undefined ? 15_000 : Number(interval)
  if (!Number.isInteger(metricExportInterval) || metricExportInterval <= 0) {
    throw new Error('OTEL_METRIC_EXPORT_INTERVAL must be a positive integer')
  }

  return {
    sentryDsn: value(env.SENTRY_DSN),
    sentryEnvironment: environment,
    sentryRelease: value(env.SENTRY_RELEASE),
    sentryTracesSampleRate,
    metricsEndpoint,
    metricExportInterval,
    resourceAttributes: {
      ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
      'service.name': serviceName,
      'service.namespace': 'northsky',
      'service.version':
        value(env.SENTRY_RELEASE) ?? env.npm_package_version ?? 'unknown',
      'service.instance.id': env.HOSTNAME ?? String(process.pid),
      'deployment.environment.name': environment,
    },
  }
}

export function initializeTelemetry(config: TelemetryConfig): {
  shutdown(): Promise<void>
} {
  if (config.sentryDsn) {
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.sentryEnvironment,
      release: config.sentryRelease,
      tracesSampleRate: config.sentryTracesSampleRate,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
      beforeBreadcrumb: scrubEvent,
      ignoreTransactions: [/^GET \/(?:health|ready|\.well-known)/],
    })
  }
  if (!config.metricsEndpoint) {
    return (telemetry = {
      shutdown: async () => {
        await Sentry.flush(5_000)
      },
    })
  }

  const provider = createMeterProvider(
    config,
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: config.metricsEndpoint,
        concurrencyLimit: 1,
      }),
      exportIntervalMillis: config.metricExportInterval,
      exportTimeoutMillis: 5_000,
    }),
  )
  metrics.setGlobalMeterProvider(provider)
  new RuntimeNodeInstrumentation().enable()

  return (telemetry = {
    shutdown: async () => {
      await flushWithinDeadline([provider.shutdown(), Sentry.flush(5_000)])
    },
  })
}

/** Construct a metrics-only provider; Sentry remains the sole tracer owner. */
export function createMeterProvider(
  config: TelemetryConfig,
  reader: PeriodicExportingMetricReader,
): MeterProvider {
  return new MeterProvider({
    resource: resourceFromAttributes(config.resourceAttributes),
    views: [
      {
        instrumentName: 'http.server.request.duration',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: HTTP_BUCKETS_SECONDS },
        },
        attributesProcessors: [
          createAllowListAttributesProcessor(METRIC_ATTRIBUTE_KEYS),
        ],
      },
      {
        instrumentName: 'stratos.*.duration',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: BACKGROUND_BUCKETS_SECONDS },
        },
        attributesProcessors: [
          createAllowListAttributesProcessor(METRIC_ATTRIBUTE_KEYS),
        ],
      },
      {
        instrumentName: 'stratos.*',
        attributesProcessors: [
          createAllowListAttributesProcessor(METRIC_ATTRIBUTE_KEYS),
        ],
      },
    ],
    readers: [reader],
  })
}
export function shutdownTelemetry(): Promise<void> {
  return telemetry.shutdown()
}

/** Capture only failures that escaped their expected domain outcome. */
export function captureUnexpectedError(error: unknown): void {
  Sentry.captureException(error)
}

/** Keep shutdown bounded even when a collector is unavailable. */
async function flushWithinDeadline(
  work: readonly Promise<unknown>[],
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000)
    void Promise.allSettled(work).then(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

/** Creates a manual span without making application code depend on a tracer. */
export function withTelemetrySpan<T>(
  name: string,
  op: string,
  work: () => Promise<T>,
): Promise<T> {
  return Sentry.startSpan({ name, op }, work)
}

export function scrubEvent<T extends object>(event: T): T {
  return scrub(event) as T
}

function scrub(value_: unknown): unknown {
  if (Array.isArray(value_)) return value_.map(scrub)
  if (!value_ || typeof value_ !== 'object') return value_

  return Object.fromEntries(
    Object.entries(value_ as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET.test(key)
        ? '[Filtered]'
        : key === 'query_string'
          ? '[Filtered]'
          : key === 'url' && typeof item === 'string'
            ? scrubUrl(item)
            : scrub(item),
    ]),
  )
}

function scrubUrl(value: string): string {
  const [beforeFragment, fragment = ''] = value.split('#', 2)
  const [path, query] = beforeFragment.split('?', 2)
  if (!query) return value
  const params = new URLSearchParams(query)
  for (const key of params.keys()) {
    if (SECRET.test(key)) params.set(key, '[Filtered]')
  }
  return `${path}?${params.toString()}${fragment ? `#${fragment}` : ''}`
}

function value(input: string | undefined): string | undefined {
  const result = input?.trim()
  return result || undefined
}
function defaultSampleRate(environment: string): number {
  return environment === 'production' ? 0.2 : 1
}
function parseResourceAttributes(
  input: string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (input ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf('=')
        if (index < 1) {
          throw new Error('OTEL_RESOURCE_ATTRIBUTES entries must use key=value')
        }
        return [entry.slice(0, index), entry.slice(index + 1)]
      }),
  )
}
