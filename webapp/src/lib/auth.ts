import {
  BrowserOAuthClient,
  type OAuthSession,
} from '@atproto/oauth-client-browser'
import type { OAuthClientMetadataInput } from '@atproto/oauth-types'

let client: BrowserOAuthClient | null = null
let currentSession: OAuthSession | null = null
let sessionDeletedCallback: (() => void) | null = null

const HANDLE_RESOLVER =
  import.meta.env.VITE_ATPROTO_HANDLE_RESOLVER ?? 'https://bsky.social'

function isLoopback(): boolean {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/**
 * Build client metadata for local development.
 *
 * @returns OAuth client metadata.
 */
function buildClientMetadata(): OAuthClientMetadataInput {
  const origin = window.location.origin
  return {
    client_id: `${origin}/client-metadata.json`,
    client_name: 'Stratos',
    client_uri: origin,
    redirect_uris: [`${origin}/`],
    scope:
      'atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post?action=create&action=delete',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}

/**
 * Get the OAuth client instance.
 *
 * @returns the OAuth client instance
 */
function getClient(): BrowserOAuthClient {
  client ??= new BrowserOAuthClient({
    handleResolver: HANDLE_RESOLVER,
    responseMode: 'query',
    ...(isLoopback() ? {} : { clientMetadata: buildClientMetadata() }),
    onDelete: (_sub, _cause) => {
      currentSession = null
      sessionDeletedCallback?.()
    },
  })
  return client
}

/**
 * Set the callback to be called when the session is deleted.
 * @param callback - the callback function to be called
 */
export function onSessionDeleted(callback: () => void): void {
  sessionDeletedCallback = callback
}

/**
 * Initialize the OAuth session.
 *
 * @returns the initialized OAuth session or null if initialization fails
 */
export async function init(): Promise<OAuthSession | null> {
  const oauthClient = getClient()
  try {
    const result = await oauthClient.init()
    if (result?.session) {
      currentSession = result.session
    }
  } catch (err) {
    console.warn('Session restore failed, clearing stale session:', err)
    currentSession = null
  }
  return currentSession
}

/**
 * Sign in with the given handle.
 * @param handle - the handle to sign in with
 */
export async function signIn(handle: string): Promise<void> {
  const oauthClient = getClient()
  await oauthClient.signIn(handle, {
    scope:
      'atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post?action=create&action=delete',
    signal: new AbortController().signal,
  })
}

/**
 * Get the current OAuth session.
 * @returns the current OAuth session or null if not signed in
 */
export function getSession(): OAuthSession | null {
  return currentSession
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  if (currentSession) {
    const oauthClient = getClient()
    await oauthClient.revoke(currentSession.sub)
    currentSession = null
  }
}
