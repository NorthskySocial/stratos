import * as Sentry from '@sentry/node'

/**
 * Propagate the active Sentry trace only to the configured upstream Stratos
 * origin. Callers must never attach these headers to caller-controlled URLs.
 */
export function upstreamTraceHeaders(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Sentry.getTraceData()).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

export function withUpstreamSpan<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  return Sentry.startSpan({ name, op: 'http.client' }, work)
}
