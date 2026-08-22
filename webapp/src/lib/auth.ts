import { buildStratosScopes } from '@northskysocial/stratos-client'
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

// The single OAuth scope string for this app. Both the authorization request
// (signIn) and the declared client metadata must use the exact same value, and
// it must match the served /client-metadata.json (webapp/Dockerfile and
// webapp/public/client-metadata.json.template) or the AS rejects with
// invalid_scope. The app.bsky.feed.post write scope is required because the
// composer creates public posts on the user's PDS (see Composer.svelte).
const OAUTH_SCOPE = [
  ...buildStratosScopes(),
  'repo:app.bsky.feed.post?action=create',
].join(' ')

function isLoopback(): boolean {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/**
 * The base URL this app publishes itself under.
 *
 * A loopback development server has no public URL, so it falls back to the
 * browser origin. A trailing slash on `VITE_WEBAPP_URL` is removed: the value
 * is joined to a path to build the `client_id`, and Stratos rejects a document
 * whose own `client_id` does not equal the URL it was fetched from.
 *
 * @returns The app base URL, without a trailing slash.
 */
export function appBaseUrl(): string {
  const configured =
    import.meta.env.VITE_WEBAPP_URL && !isLoopback()
      ? import.meta.env.VITE_WEBAPP_URL
      : window.location.origin
  return configured.replace(/\/+$/, '')
}

/**
 * The URL of this app's client metadata document.
 *
 * Stratos reads this document to confirm that the app owns the enrollment
 * redirect target it asks for.
 *
 * @returns The client metadata document URL.
 */
export function getClientId(): string {
  return `${appBaseUrl()}/client-metadata.json`
}

/**
 * Build client metadata for local development.
 *
 * @returns OAuth client metadata.
 */
function buildClientMetadata(): OAuthClientMetadataInput {
  return {
    client_id: getClientId(),
    client_name: 'Stratos',
    client_uri: appBaseUrl(),
    redirect_uris: [`${appBaseUrl()}/`],
    scope: OAUTH_SCOPE,
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
    onSessionDeleted: (_sub, _cause) => {
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
    if (err instanceof Error && err.name === 'AbortError') {
      // ignore
    } else {
      console.warn('Session restore failed, clearing stale session:', err)
      currentSession = null
    }
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
    scope: OAUTH_SCOPE,
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
