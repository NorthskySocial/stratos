import { Agent } from '@atproto/api'
import { Lexicons } from '@atproto/lexicon'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { stratosLexicons } from '@northskysocial/stratos-core'

/**
 * Configure an Agent with Stratos lexicons.
 * @param agent - the Agent to configure
 * @returns the configured Agent
 */
export function configureAgent(agent: Agent): Agent {
  const lex = new Lexicons(stratosLexicons)
  if (agent.api) {
    agent.api.lex = lex
  } else {
    // If agent.api is not yet initialized (e.g., in some test environments),
    // we can try to set it via the private property or just ignore it if it's a mock.
    // In newer versions of @atproto/api, it might be initialized lazily.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(agent as any).api = { lex }
  }
  return agent
}

/**
 * Creates an Agent that routes XRPC calls to a service URL
 * using the OAuth session's DPoP-authenticated fetch.
 *
 * @param session - the OAuth session
 * @param serviceUrl - the target service URL
 * @returns an Agent that routes calls to the target service
 */
export function createServiceAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  const agent = new Agent({
    service: serviceUrl,
    fetch: createServiceFetch(session, serviceUrl),
  })

  return configureAgent(agent)
}

/**
 * Creates a fetch function that routes XRPC calls to a service URL
 * @param session - the OAuth session
 * @param serviceUrl - the target service URL
 * @returns a fetch function that routes calls to the target service
 */
export function createServiceFetch(
  session: OAuthSession,
  serviceUrl: string,
): (url: string, init?: RequestInit) => Promise<Response> {
  // OAuthSession.fetchHandler resolves URLs against tokenSet.aud (the PDS).
  // Wrap it so relative XRPC pathnames resolve against the target service instead.
  return async (url: string, init?: RequestInit) => {
    let fullUrl: URL
    try {
      fullUrl = new URL(url)
      const serviceBase = new URL(serviceUrl)
      // Force absolute URLs to point to our target service
      fullUrl.protocol = serviceBase.protocol
      fullUrl.host = serviceBase.host
      fullUrl.port = serviceBase.port
    } catch {
      // url was relative, resolve against serviceUrl
      fullUrl = new URL(url, serviceUrl)
    }

    // We must clone the body if it's a blob/file to allow retries
    // because session.fetchHandler might consume it on the first attempt.
    const canRetry =
      init?.method === 'POST' ||
      init?.method === 'PUT' ||
      init?.method === 'PATCH'

    const requestInit = init
    if (canRetry && init?.body instanceof Blob) {
      // Blobs can be reused, but we should be careful.
      // Actually, standard fetch doesn't consume Blobs.
    }

    const isUploadBlob =
      fullUrl.pathname.endsWith('/com.atproto.repo.uploadBlob') ||
      fullUrl.pathname.endsWith('/zone.stratos.repo.uploadBlob')
    const isGetBlob =
      fullUrl.pathname.endsWith('/zone.stratos.sync.getBlob') ||
      fullUrl.pathname.endsWith('/com.atproto.sync.getBlob')

    if (isUploadBlob || isGetBlob) {
      console.log(`[StratosAgent] Preparing request to ${fullUrl.href}`)
      console.log(`[StratosAgent] Session status:`, {
        sub: session.sub,
        hasFetchHandler: !!session.fetchHandler,
      })
    }

    const res = await session.fetchHandler(fullUrl.href, requestInit)

    if (isUploadBlob || isGetBlob) {
      console.log(`[StratosAgent] Response: ${res.status} ${res.statusText}`)
    }

    // Handle DPoP nonce retry for Stratos service
    if (res.status === 401) {
      const body = await res
        .clone()
        .json()
        .catch(() => ({}))
      if (
        (body.error === 'AuthenticationRequired' &&
          body.message === 'DPoP nonce required') ||
        (body.error === 'InvalidToken' &&
          body.message === 'DPoP nonce required') ||
        res.headers.has('dpop-nonce')
      ) {
        // If we get a DPoP nonce required error, session.fetchHandler should
        // ideally handle it, but it might not if the host changed.
        // By retrying, we give it another chance to use the nonce it just received.
        return session.fetchHandler(fullUrl.href, requestInit)
      }
    }
    return res
  }
}

/**
 * Creates a Stratos Agent that routes XRPC calls to a specific Stratos service URL.
 * @param session - the OAuth session
 * @param serviceUrl - the target Stratos service URL
 * @returns an Agent that routes calls to the target Stratos service
 */
export function createStratosAgent(
  session: OAuthSession,
  serviceUrl: string,
): Agent {
  return createServiceAgent(session, serviceUrl)
}
