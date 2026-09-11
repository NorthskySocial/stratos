import { fetchMaxSizeProcessor } from '@atproto-labs/fetch'

export const MAX_RESPONSE_BYTES = 512 * 1024
export const REQUEST_TIMEOUT_MS = 10_000

export function createBoundedFetch(
  baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  const limitResponse = fetchMaxSizeProcessor(MAX_RESPONSE_BYTES)
  return async (input, init) => {
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout
    // Fetch exposes decoded bytes; Content-Length alone only bounds the wire body.
    return limitResponse(await baseFetch(input, { ...init, signal }))
  }
}
