import type { IdResolver } from '@atproto/identity'
import {
  createOAuthClient,
  OAUTH_SCOPE,
  type OAuthSessionStoreBackend,
  type OAuthStateStoreBackend,
} from './client.js'
import type { StratosServiceConfig } from '../config.js'

/**
 * Creates the OAuth client context
 *
 * @param cfg - Stratos service configuration
 * @param oauthStores - OAuth session and state stores
 * @param idResolver - Identity resolver for DID resolution
 * @param fetchWithUserAgent - Fetch function with user agent
 * @returns OAuth client context
 */
export async function createOAuthClientContext(
  cfg: StratosServiceConfig,
  oauthStores: {
    sessionStore: OAuthSessionStoreBackend
    stateStore: OAuthStateStoreBackend
  },
  idResolver: IdResolver,
  fetchWithUserAgent: typeof fetch,
) {
  return createOAuthClient(
    {
      clientId:
        cfg.oauth.clientId ?? `${cfg.service.publicUrl}/client-metadata.json`,
      clientUri: cfg.service.publicUrl,
      redirectUri: `${cfg.service.publicUrl}/oauth/callback`,
      privateKeyPem: cfg.oauth.clientSecret,
      scope: OAUTH_SCOPE,
      clientName: cfg.oauth.clientName,
      logoUri: cfg.oauth.logoUri,
      tosUri: cfg.oauth.tosUri,
      policyUri: cfg.oauth.policyUri,
    },
    oauthStores,
    idResolver,
    fetchWithUserAgent,
  )
}
