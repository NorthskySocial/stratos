import { StratosClientError } from './errors.js'

/**
 * Summarize an upstream call failure for a log line.
 *
 * A `StratosClientError` carries the response body verbatim. That body comes
 * from the other end, and if the service URL is ever misrouted it comes from a
 * host we did not mean to call. Truncating it still logs whatever was sent, so
 * log only fields we choose: the status, the method, and the XRPC error code.
 */
export function describeUpstreamError(err: unknown): string {
  if (err instanceof StratosClientError) {
    const code = extractErrorCode(err.body)
    return code
      ? `${err.status} ${err.lxm}: ${code}`
      : `${err.status} ${err.lxm}`
  }
  if (err instanceof Error) return err.name
  return 'unknown error'
}

/** Maximum length of a value we will accept as an XRPC error code. */
const MAX_ERROR_CODE_LENGTH = 64

/**
 * Read the `error` code from an XRPC error body.
 *
 * Only the code is taken. `message` is free text from the other end, and the
 * code alone tells one failure from another.
 */
function extractErrorCode(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const code = (parsed as { error?: unknown }).error
  if (typeof code !== 'string') return undefined
  // An error code is a short identifier. Anything longer is not one.
  return code.length <= MAX_ERROR_CODE_LENGTH ? code : undefined
}
