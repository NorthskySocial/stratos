import { Agent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { stratosLexicons } from '@northskysocial/stratos-client/lexicons'

/** Settings for a DPoP-authenticated service agent. */
export interface ServiceAgentOptions {
  /** OAuth session whose fetch handler mints DPoP proofs. */
  session: OAuthSession
  /** Target XRPC service URL. */
  serviceUrl: string
  /** Additional lexicons to register alongside the bundled Stratos lexicons. */
  lexicons?: Iterable<LexiconDoc>
}

/** Add application lexicons while preserving the Agent's built-in definitions. */
export function configureAgent(
  agent: Agent,
  additionalLexicons?: Iterable<LexiconDoc>,
): Agent {
  for (const doc of [...stratosLexicons, ...(additionalLexicons ?? [])]) {
    try {
      agent.api.lex.add(doc)
    } catch {
      // The base Agent can already provide shared com.atproto definitions.
    }
  }
  return agent
}

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request
}

function getServiceUrl(
  input: Exclude<RequestInfo | URL, Request>,
  serviceUrl: string,
): string {
  const value = typeof input === 'string' ? input : input.href
  try {
    const target = new URL(value)
    const serviceBase = new URL(serviceUrl)
    target.protocol = serviceBase.protocol
    target.host = serviceBase.host
    return target.href
  } catch {
    return new URL(value, serviceUrl).href
  }
}

function hasNonceErrorBody(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const body = value as Record<string, unknown>
  return (
    (body.error === 'AuthenticationRequired' ||
      body.error === 'InvalidToken') &&
    body.message === 'DPoP nonce required'
  )
}

async function requiresDpopNonceRetry(response: Response): Promise<boolean> {
  if (response.status !== 401) {
    return false
  }
  if (response.headers.has('dpop-nonce')) {
    return true
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined)
  return hasNonceErrorBody(body)
}

/**
 * Route XRPC calls to a service while retaining the session's DPoP-aware fetch
 * handler. A nonce challenge is retried once so the OAuth client can replay it
 * with the nonce it just received from the target service.
 */
export function createServiceFetch(
  session: OAuthSession,
  serviceUrl: string,
): (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> {
  return async (input: URL | RequestInfo, init?: RequestInit) => {
    if (isRequest(input)) {
      throw new TypeError(
        'createServiceFetch does not accept a Request. Pass a URL or a string with RequestInit.',
      )
    }
    const targetUrl = getServiceUrl(input, serviceUrl)
    const response = await session.fetchHandler(targetUrl, init)
    if (await requiresDpopNonceRetry(response)) {
      return session.fetchHandler(targetUrl, init)
    }
    return response
  }
}

/** Create an Agent configured for a DPoP-authenticated Stratos-compatible service. */
export function createServiceAgent({
  session,
  serviceUrl,
  lexicons,
}: ServiceAgentOptions): Agent {
  const agent = new Agent({
    service: serviceUrl,
    fetch: createServiceFetch(session, serviceUrl),
  })
  return configureAgent(agent, lexicons)
}
