import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

/**
 * Creates an Agent that routes XRPC calls to a Stratos service URL
 * using the OAuth session's DPoP-authenticated fetch.
 *
 * Follows the createServiceFetchHandler pattern from stratos-client:
 * resolves relative XRPC pathnames against the target service URL,
 * while the underlying session fetch handles DPoP proof generation
 * with the correct htu derived from the actual request URL.
 */
export function createStratosAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  const agent = new Agent(session)

  // Override the service URL so the agent sends requests to Stratos
  // The Agent internally uses the session's fetchHandler which handles
  // DPoP proof generation based on the actual request URL
  agent.serviceUrl = new URL(serviceUrl)

  return agent
}
