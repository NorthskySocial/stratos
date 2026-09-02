import type { IdResolver } from '@atproto/identity'
import {
  buildOAuthScope,
  createOAuthClient,
  isolateAdminOAuthStores,
  type OAuthClientConfig,
  type OAuthSessionStoreBackend,
  type OAuthStateStoreBackend,
} from './client.js'
import type { StratosServiceConfig } from '../config.js'
import { NodeOAuthClient } from '@atproto/oauth-client-node'

/**
 * Build the client configuration shared by the enrollment and admin clients.
 * Both clients must publish identical metadata under one `client_id`.
 */
function oauthClientConfig(cfg: StratosServiceConfig): OAuthClientConfig {
  return {
    clientId:
      cfg.oauth.clientId ?? `${cfg.service.publicUrl}/client-metadata.json`,
    clientUri: cfg.service.publicUrl,
    redirectUri: `${cfg.service.publicUrl}/oauth/callback`,
    adminRedirectUri: `${cfg.service.publicUrl}/admin/oauth/callback`,
    privateKeyPem: cfg.oauth.clientSecret,
    scope: buildOAuthScope(cfg.service.did),
    clientName: cfg.oauth.clientName,
    logoUri: cfg.oauth.logoUri,
    tosUri: cfg.oauth.tosUri,
    policyUri: cfg.oauth.policyUri,
    ...(cfg.stratos.devMode === true ? { allowHttp: true } : {}),
  }
}

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
): Promise<NodeOAuthClient> {
  return createOAuthClient(
    oauthClientConfig(cfg),
    oauthStores,
    idResolver,
    fetchWithUserAgent,
  )
}

/**
 * Creates the OAuth client for the admin login flow.
 *
 * Same client metadata as the enrollment client, but the sessions and states
 * persist under a separate key space. This keeps an admin login from
 * overwriting the same DID's repo-write enrollment session.
 */
export async function createAdminOAuthClientContext(
  cfg: StratosServiceConfig,
  oauthStores: {
    sessionStore: OAuthSessionStoreBackend
    stateStore: OAuthStateStoreBackend
  },
  idResolver: IdResolver,
  fetchWithUserAgent: typeof fetch,
): Promise<NodeOAuthClient> {
  return createOAuthClient(
    oauthClientConfig(cfg),
    isolateAdminOAuthStores(oauthStores),
    idResolver,
    fetchWithUserAgent,
  )
}
