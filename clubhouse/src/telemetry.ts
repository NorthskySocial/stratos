import * as Sentry from '@sentry/svelte'

interface ClubhouseTelemetryEnvironment {
  VITE_SENTRY_DSN?: string
  VITE_SENTRY_ENVIRONMENT?: string
  VITE_SENTRY_RELEASE?: string
  VITE_SENTRY_TRACES_SAMPLE_RATE?: string
  VITE_STRATOS_URL?: string
}

const SECRET =
  /^(?:authorization|cookie|set-cookie|dpop|dpop-nonce|(?:access|refresh|id)[_-]?token|token|client[_-]?secret|secret|password|post(?:body)?|oauth(?:code)?|authorization[_-]?code|code[_-]?verifier|state)$/i

/** Initialize browser telemetry before any application module is imported. */
export function initializeClubhouseTelemetry(
  environment: ClubhouseTelemetryEnvironment = import.meta
    .env as ClubhouseTelemetryEnvironment,
): void {
  const dsn = value(environment.VITE_SENTRY_DSN)
  if (!dsn) return
  const deployment = value(environment.VITE_SENTRY_ENVIRONMENT) ?? 'development'
  Sentry.init({
    dsn,
    environment: deployment,
    release: value(environment.VITE_SENTRY_RELEASE),
    tracesSampleRate: sampleRate(
      environment.VITE_SENTRY_TRACES_SAMPLE_RATE,
      deployment,
    ),
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracePropagationTargets: directStratosOrigin(environment.VITE_STRATOS_URL),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubEvent,
  })
}

/** Keep interaction names stable and avoid passing user content as span data. */
export function withClubhouseSpan<T>(name: string, work: () => T): T {
  return Sentry.startSpan({ name, op: 'ui.action' }, work)
}

export function captureClubhouseException(error: unknown): void {
  Sentry.captureException(error)
}

export function scrubEvent<T extends object>(event: T): T {
  return scrub(event, []) as T
}

function directStratosOrigin(value_: string | undefined): string[] {
  if (!value_) return []
  try {
    return [new URL(value_).origin]
  } catch {
    return []
  }
}

function sampleRate(value_: string | undefined, deployment: string): number {
  if (!value_?.trim()) return deployment === 'production' ? 0.1 : 1
  const rate = Number(value_)
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return 0
  return rate
}

function value(input: string | undefined): string | undefined {
  const result = input?.trim()
  return result || undefined
}

function scrub(value_: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value_)) return value_.map((item) => scrub(item, path))
  if (!value_ || typeof value_ !== 'object') return value_
  return Object.fromEntries(
    Object.entries(value_ as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET.test(key) ||
      ((key === 'body' || key === 'data') && path.includes('request'))
        ? '[Filtered]'
        : scrub(item, [...path, key]),
    ]),
  )
}
