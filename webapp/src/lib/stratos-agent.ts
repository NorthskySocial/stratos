import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

/**
 * Creates an Agent that routes XRPC calls to a service URL
 * using the OAuth session's DPoP-authenticated fetch.
 *
 * @param session - the OAuth session
 * @param serviceUrl - the target service URL
 * @returns an Agent that routes calls to the target service
 */
export function createServiceAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return new Agent(createServiceFetch(session, serviceUrl))
}

/**
 * Creates a fetch function that routes XRPC calls to a service URL
 * @param session - the OAuth session
 * @param serviceUrl - the target service URL
 * @returns a fetch function that routes calls to the target service
 */
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

/**
 * Creates a Stratos Agent that routes XRPC calls to a specific Stratos service URL.
 * @param session - the OAuth session
 * @param serviceUrl - the target Stratos service URL
 * @returns an Agent that routes calls to the target Stratos service
 */
export function createStratosAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return createServiceAgent(session, serviceUrl)
}
