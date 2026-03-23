import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

/**
 * Creates an Agent that routes XRPC calls to a service URL
 * using the OAuth session's DPoP-authenticated fetch.
 *
 */
export function createServiceAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return new Agent(createServiceFetch(session, serviceUrl))
}

export function createServiceFetch(
  session: OAuthSession,
  serviceUrl: string,
): (url: string, init?: RequestInit) => Promise<Response> {
  // OAuthSession.fetchHandler resolves URLs against tokenSet.aud (the PDS).
  // Wrap it so relative XRPC pathnames resolve against the target service instead.
  return (url: string, init?: RequestInit) => {
    const fullUrl = new URL(url, serviceUrl)
    return session.fetchHandler(fullUrl.href, init)
  }
}

export function createStratosAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return createServiceAgent(session, serviceUrl)
}
