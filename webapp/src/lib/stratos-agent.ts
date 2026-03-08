import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

/**
 * Creates an Agent that routes XRPC calls to a Stratos service URL
 * using the OAuth session's DPoP-authenticated fetch.
 *
 */
export function createStratosAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  // OAuthSession.fetchHandler resolves URLs against tokenSet.aud (the PDS).
  // Wrap it so relative XRPC pathnames resolve against the Stratos service URL instead.
  return new Agent((url: string, init: RequestInit) => {
    const fullUrl = new URL(url, serviceUrl)
    return session.fetchHandler(fullUrl.href, init)
  })
}
