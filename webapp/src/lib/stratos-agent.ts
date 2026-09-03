import type { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import {
  configureAgent as configureSharedAgent,
  createServiceAgent as createSharedServiceAgent,
  createServiceFetch,
} from '@northskysocial/stratos-browser'

/** Configure an Agent with Stratos lexicons. */
export function configureAgent(agent: Agent): Agent {
  return configureSharedAgent(agent)
}

/** Create a DPoP-authenticated Agent for a target XRPC service. */
export function createServiceAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return createSharedServiceAgent({ session, serviceUrl })
}

export { createServiceFetch }

/** Create a DPoP-authenticated Agent for a Stratos service. */
export function createStratosAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return createServiceAgent(session, serviceUrl)
}
