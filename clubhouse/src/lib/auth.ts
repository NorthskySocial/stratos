import {
  buildSpaceWriteScope,
  createBrowserAuth,
  type BrowserAuth,
} from '@northskysocial/stratos-browser'
import {
  clubhouseBaseUrl,
  clubhouseClientId,
  clubhouseRedirectUri,
  type ClubhouseConfig,
} from './config'

function isLoopback(): boolean {
  const hostname = window.location.hostname
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  )
}

/** Create the shared OAuth client; protocol handling stays in stratos-browser. */
export function createClubhouseAuth(config: ClubhouseConfig): BrowserAuth {
  const scopes = [
    'atproto',
    'repo:zone.stratos.actor.enrollment',
    'repo:zone.stratos.feed.post?action=create',
    ...(config.feedgenDid
      ? ['rpc:zone.stratos.feedgen.getFeed?aud=*']
      : []),
  ]
  return createBrowserAuth({
    appName: 'Clubhouse',
    scopes,
    spaceWriteScope: config.serviceDid
      ? { serviceDid: config.serviceDid }
      : undefined,
    handleResolver:
      import.meta.env.VITE_ATPROTO_HANDLE_RESOLVER || 'https://bsky.social',
    oauthProxyUrl: import.meta.env.VITE_ATPROTO_OAUTH_PROXY_URL,
    getBaseUrl: () => clubhouseBaseUrl(config),
    getClientId: () => clubhouseClientId(config),
    getRedirectUri: () => clubhouseRedirectUri(config),
    isLoopback,
    onSessionRestoreError: (error: unknown) =>
      console.warn('Clubhouse session restore failed', error),
  })
}

/** Re-exported for client-metadata generation and focused scope tests. */
export { buildSpaceWriteScope }
export { clubhouseBaseUrl, clubhouseClientId, clubhouseRedirectUri }
