import {
  BrowserOAuthClient,
  type OAuthSession,
} from '@atproto/oauth-client-browser'
import type { OAuthClientMetadataInput } from '@atproto/oauth-types'

let client: BrowserOAuthClient | null = null
let currentSession: OAuthSession | null = null

function isLoopback(): boolean {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

function buildClientMetadata(): OAuthClientMetadataInput {
  const origin = window.location.origin
  return {
    client_id: `${origin}/client-metadata.json`,
    client_name: 'Stratos',
    client_uri: origin,
    redirect_uris: [`${origin}/`],
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}

function getClient(): BrowserOAuthClient {
  if (!client) {
    client = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      responseMode: 'query',
      ...(isLoopback() ? {} : { clientMetadata: buildClientMetadata() }),
    })
  }
  return client
}

export async function init(): Promise<OAuthSession | null> {
  const oauthClient = getClient()
  const result = await oauthClient.init()
  if (result?.session) {
    currentSession = result.session
  }
  return currentSession
}

export async function signIn(handle: string): Promise<void> {
  const oauthClient = getClient()
  await oauthClient.signIn(handle, {
    scope: 'atproto transition:generic',
    signal: new AbortController().signal,
  })
}

export function getSession(): OAuthSession | null {
  return currentSession
}

export async function signOut(): Promise<void> {
  if (currentSession) {
    const oauthClient = getClient()
    await oauthClient.revoke(currentSession.sub)
    currentSession = null
  }
}
