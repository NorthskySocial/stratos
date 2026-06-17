import { InvalidRequestError } from '@atproto/xrpc-server'
import type { MethodAuthVerifier } from '@atproto/xrpc-server'
import type { FeedRequestVerifier, RequestHeaders } from '../auth/index.js'

export interface XrpcAuthCredentials {
  viewerDid: string
  lxm: string
}

/**
 * Adapt a {@link FeedRequestVerifier} to the shape `@atproto/xrpc-server`
 * expects for per-method `auth` verifiers.
 */
export function toXrpcAuthVerifier(
  verifier: FeedRequestVerifier,
): MethodAuthVerifier<{ credentials: XrpcAuthCredentials }> {
  return async ({ req }) => {
    const result = await verifier({ headers: req.headers })
    return {
      credentials: { viewerDid: result.viewerDid, lxm: result.lxm },
    }
  }
}

export class UnknownFeedError extends InvalidRequestError {
  constructor(feedId: string) {
    super(`Unknown feed: ${feedId}`, 'UnknownFeed')
  }
}

export class BoundaryMismatchError extends InvalidRequestError {
  constructor(boundary: string) {
    super(`Viewer is not enrolled in boundary: ${boundary}`, 'BoundaryMismatch')
  }
}
