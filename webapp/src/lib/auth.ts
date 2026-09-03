import { buildStratosScopes } from '@northskysocial/stratos-client'
import {
  buildSpaceWriteScope as buildSharedSpaceWriteScope,
  createBrowserAuth,
  type BrowserAuthScopeStatus,
} from '@northskysocial/stratos-browser'
import type { OAuthSession } from '@atproto/oauth-client-browser'

/** Build the webapp's canonical Stratos feed-space write scope. */
export function buildSpaceWriteScope(
  serviceDid = import.meta.env.VITE_STRATOS_SERVICE_DID,
): string {
  return buildSharedSpaceWriteScope({ serviceDid })
}

export const SPACE_WRITE_SCOPE = buildSpaceWriteScope()

export type SpaceWriteScopeStatus = BrowserAuthScopeStatus

const HANDLE_RESOLVER =
  import.meta.env.VITE_ATPROTO_HANDLE_RESOLVER || 'https://bsky.social'
const OAUTH_PROXY_URL = import.meta.env.VITE_ATPROTO_OAUTH_PROXY_URL

function isLoopback(): boolean {
  const hostname = window.location.hostname
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  )
}

/**
 * The base URL this app publishes itself under. A loopback development server
 * has no public URL, so it falls back to the browser origin.
 */
export function appBaseUrl(): string {
  const configured =
    import.meta.env.VITE_WEBAPP_URL && !isLoopback()
      ? import.meta.env.VITE_WEBAPP_URL
      : window.location.origin
  return configured.replace(/\/+$/, '')
}

/** The URL of this app's OAuth client metadata document. */
export function getClientId(): string {
  return `${appBaseUrl()}/client-metadata.json`
}

const auth = createBrowserAuth({
  appName: 'Stratos',
  scopes: [...buildStratosScopes(), 'repo:app.bsky.feed.post?action=create'],
  spaceWriteScope: { serviceDid: import.meta.env.VITE_STRATOS_SERVICE_DID },
  handleResolver: HANDLE_RESOLVER,
  oauthProxyUrl: OAUTH_PROXY_URL,
  getBaseUrl: appBaseUrl,
  getClientId,
  getRedirectUri: () => `${appBaseUrl()}/`,
  isLoopback,
  onSessionRestoreError: (error) => {
    console.warn('Session restore failed, clearing stale session:', error)
  },
})

/** Check whether a session has the space scope used for PDS-hosted posts. */
export async function hasSpaceWriteScope(
  session: OAuthSession,
): Promise<boolean> {
  return auth.hasScope(session, SPACE_WRITE_SCOPE)
}

/** Distinguish a missing space scope from a token-information lookup failure. */
export async function getSpaceWriteScopeStatus(
  session: OAuthSession,
): Promise<SpaceWriteScopeStatus> {
  return auth.getScopeStatus(session, SPACE_WRITE_SCOPE)
}

/** Set the callback invoked when the current OAuth session is deleted. */
export function onSessionDeleted(callback: () => void): void {
  auth.onSessionDeleted(callback)
}

/** Initialize browser OAuth and restore an existing session when present. */
export async function init(): Promise<OAuthSession | null> {
  return auth.init()
}

/** Start browser OAuth sign-in for a handle. */
export async function signIn(handle: string): Promise<void> {
  return auth.signIn(handle)
}

/** Get the current OAuth session. */
export function getSession(): OAuthSession | null {
  return auth.getSession()
}

/** Revoke and clear the current OAuth session. */
export async function signOut(): Promise<void> {
  return auth.signOut()
}
