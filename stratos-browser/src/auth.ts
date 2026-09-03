import {
  BrowserOAuthClient,
  type OAuthSession,
} from '@atproto/oauth-client-browser'
import {
  buildAtprotoLoopbackClientMetadata,
  type OAuthClientMetadataInput,
} from '@atproto/oauth-types'

/** Configuration for the Stratos space scope requested by an application. */
export interface SpaceWriteScopeConfig {
  /** DID of the Stratos space authority. */
  serviceDid?: string
  /** Space NSID to request access to. */
  space?: string
  /** Record collection to request access to. */
  collection?: string
  /** Allowed space actions, in their required canonical order. */
  actions?: readonly string[]
}

/** Status of a token scope lookup. */
export type BrowserAuthScopeStatus = 'granted' | 'missing' | 'unavailable'

/**
 * Browser-specific application settings. URL callbacks keep this package free
 * of bundler environment access and allow each app to own its deployment URLs.
 */
export interface BrowserAuthConfig {
  /** Human-readable application name published in OAuth client metadata. */
  appName: string
  /** OAuth scopes requested during sign-in and declared in client metadata. */
  scopes: readonly string[]
  /** Optional Stratos space scope, built from injected authority metadata. */
  spaceWriteScope?: SpaceWriteScopeConfig
  /** Handle resolver used by the OAuth client. */
  handleResolver: string
  /** Returns the application base URL. */
  getBaseUrl: () => string
  /** Returns the OAuth redirect URI. Defaults to `${getBaseUrl()}/`. */
  getRedirectUri?: () => string
  /** Returns the metadata URL used as the OAuth client ID. */
  getClientId?: () => string
  /** Whether this app is currently using a loopback origin. */
  isLoopback: () => boolean
  /** Optional proxy for browser OAuth requests. */
  oauthProxyUrl?: string
  /** Fetch implementation. Defaults to the browser global fetch. */
  fetch?: typeof globalThis.fetch
  /** Called after a non-abort session-restore failure. */
  onSessionRestoreError?: (error: unknown) => void
}

/** Per-application browser OAuth state and operations. */
export interface BrowserAuth {
  /** The exact space-separated scope string sent to OAuth. */
  readonly scope: string
  /** Restore the current session, including an OAuth callback when present. */
  init: () => Promise<OAuthSession | null>
  /** Start OAuth sign-in for a handle. */
  signIn: (handle: string) => Promise<void>
  /** Get the last restored or authenticated session. */
  getSession: () => OAuthSession | null
  /** Revoke the current session and clear local session state. */
  signOut: () => Promise<void>
  /** Replace the callback invoked when the OAuth library deletes a session. */
  onSessionDeleted: (callback: () => void) => void
  /** Check whether an OAuth token includes an exact requested scope. */
  hasScope: (session: OAuthSession, scope: string) => Promise<boolean>
  /** Distinguish a missing scope from an unavailable token-information lookup. */
  getScopeStatus: (
    session: OAuthSession,
    scope: string,
  ) => Promise<BrowserAuthScopeStatus>
}

/** Build the canonical scope used to write a Stratos feed space. */
export function buildSpaceWriteScope({
  serviceDid,
  space = 'zone.stratos.space.feed',
  collection = 'zone.stratos.feed.post',
  actions = ['read', 'create'],
}: SpaceWriteScopeConfig = {}): string {
  const parameters = new URLSearchParams({
    authority: serviceDid ?? '',
    collection,
  })
  for (const action of actions) {
    parameters.append('action', action)
  }
  return `space:${space}?${parameters.toString()}`
}

/** Remove trailing slashes before joining an application URL to a path. */
export function normalizeBrowserBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function getDefaultRedirectUri(config: BrowserAuthConfig): string {
  return `${normalizeBrowserBaseUrl(config.getBaseUrl())}/`
}

function getClientId(config: BrowserAuthConfig): string {
  return (
    config.getClientId?.() ??
    `${normalizeBrowserBaseUrl(config.getBaseUrl())}/client-metadata.json`
  )
}

function getRedirectUri(config: BrowserAuthConfig): string {
  return config.getRedirectUri?.() ?? getDefaultRedirectUri(config)
}

function getLoopbackRedirectUri(redirectUri: string): string {
  const url = new URL(redirectUri)
  if (url.hostname === 'localhost') {
    url.hostname = '127.0.0.1'
  }
  return url.href
}

function getClientMetadata(
  config: BrowserAuthConfig,
  scope: string,
): OAuthClientMetadataInput {
  const redirectUri = getRedirectUri(config)
  if (config.isLoopback()) {
    return buildAtprotoLoopbackClientMetadata({
      scope,
      redirect_uris: [getLoopbackRedirectUri(redirectUri)],
    })
  }

  const baseUrl = normalizeBrowserBaseUrl(config.getBaseUrl())
  return {
    client_id: getClientId(config),
    client_name: config.appName,
    client_uri: baseUrl,
    redirect_uris: [redirectUri],
    scope,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  }
}

function createOAuthFetch(config: BrowserAuthConfig): typeof globalThis.fetch {
  const browserFetch = config.fetch ?? globalThis.fetch
  const proxyUrl = config.oauthProxyUrl
  const proxyOrigin = proxyUrl
    ? new URL(config.handleResolver).origin
    : undefined

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const requestUrl = new URL(request.url)
    if (!proxyUrl || requestUrl.origin !== proxyOrigin) {
      return browserFetch(request)
    }

    const proxyBase = `${proxyUrl.replace(/\/+$/, '')}/`
    const targetUrl = new URL(
      `${requestUrl.pathname.slice(1)}${requestUrl.search}`,
      proxyBase,
    )
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer()
    return browserFetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: request.redirect,
      credentials: request.credentials,
      signal: request.signal,
    })
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Create isolated browser OAuth state for one application. The factory is
 * deliberately not a singleton: two apps can coexist in the same browser
 * process without sharing configuration or session callbacks.
 */
export function createBrowserAuth(config: BrowserAuthConfig): BrowserAuth {
  const scope = [
    ...config.scopes,
    ...(config.spaceWriteScope
      ? [buildSpaceWriteScope(config.spaceWriteScope)]
      : []),
  ].join(' ')
  let client: BrowserOAuthClient | null = null
  let currentSession: OAuthSession | null = null
  let sessionDeletedCallback: (() => void) | null = null

  const getClient = (): BrowserOAuthClient => {
    client ??= new BrowserOAuthClient({
      fetch: createOAuthFetch(config),
      handleResolver: config.handleResolver,
      responseMode: 'query',
      allowHttp: config.isLoopback(),
      clientMetadata: getClientMetadata(config, scope),
      onSessionDeleted: () => {
        currentSession = null
        sessionDeletedCallback?.()
      },
    })
    return client
  }

  const hasScope = async (
    session: OAuthSession,
    requestedScope: string,
  ): Promise<boolean> => {
    const tokenInfo = await session.getTokenInfo(false)
    return tokenInfo.scope.split(' ').includes(requestedScope)
  }

  return {
    scope,
    async init(): Promise<OAuthSession | null> {
      try {
        const result = await getClient().init()
        if (result?.session) {
          currentSession = result.session
        }
      } catch (error) {
        if (!isAbortError(error)) {
          currentSession = null
          config.onSessionRestoreError?.(error)
        }
      }
      return currentSession
    },
    async signIn(handle: string): Promise<void> {
      await getClient().signIn(handle, {
        scope,
        signal: new AbortController().signal,
      })
    },
    getSession(): OAuthSession | null {
      return currentSession
    },
    async signOut(): Promise<void> {
      if (currentSession) {
        await getClient().revoke(currentSession.sub)
        currentSession = null
      }
    },
    onSessionDeleted(callback: () => void): void {
      sessionDeletedCallback = callback
    },
    hasScope,
    async getScopeStatus(
      session: OAuthSession,
      requestedScope: string,
    ): Promise<BrowserAuthScopeStatus> {
      try {
        return (await hasScope(session, requestedScope)) ? 'granted' : 'missing'
      } catch {
        return 'unavailable'
      }
    },
  }
}
