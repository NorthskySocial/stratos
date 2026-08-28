import { StratosClientError } from './errors.js'

/** Cap on the logged response body for a failed upstream call. */
export const MAX_LOGGED_ERROR_BODY_LENGTH = 200

/**
 * Summarize an upstream call failure for a log line. A raw
 * `StratosClientError` carries the response body verbatim and uncapped,
 * which can be arbitrarily large or contain more of the response than a log
 * line should hold.
 */
export function describeUpstreamError(err: unknown): string {
  if (err instanceof StratosClientError) {
    const body =
      err.body.length > MAX_LOGGED_ERROR_BODY_LENGTH
        ? `${err.body.slice(0, MAX_LOGGED_ERROR_BODY_LENGTH)}…`
        : err.body
    return `${err.status} ${err.lxm}: ${body}`
  }
  return err instanceof Error ? err.message : String(err)
}
