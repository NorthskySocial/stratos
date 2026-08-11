import {
  oauthClientIdDiscoverableSchema,
  oauthClientMetadataSchema,
} from '@atproto/oauth-types'
import { isAllowedRedirectOrigin } from '../config.js'

/**
 * Largest client metadata document the service will read, in bytes.
 *
 * The document is fetched from a caller-supplied origin, so the read must be
 * bounded even when the remote server ignores the request.
 */
const MAX_CLIENT_METADATA_BYTES = 64 * 1024

const CLIENT_METADATA_TIMEOUT_MS = 5_000

/**
 * Fetch and parse the client metadata document named by a `client_id`.
 *
 * The caller controls the URL, so the request is constrained: the schema
 * rejects a non-HTTPS URL and an IP-literal host, redirects are not followed,
 * the request times out, and the body size is capped. The document must also
 * name itself, which is what binds the document to the `client_id`.
 *
 * @param clientId - The caller's `client_id`, a URL to its metadata document
 * @returns The declared `redirect_uris`
 * @throws Error if the document cannot be fetched, parsed, or does not match
 */
export async function fetchClientRedirectUris(
  clientId: string,
): Promise<string[]> {
  const parsed = oauthClientIdDiscoverableSchema.safeParse(clientId)
  if (!parsed.success) {
    throw new Error('client_id is not a discoverable client metadata URL')
  }

  const response = await fetch(parsed.data, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`client metadata document returned ${response.status}`)
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > MAX_CLIENT_METADATA_BYTES) {
    throw new Error('client metadata document is too large')
  }

  const body = await response.text()
  if (body.length > MAX_CLIENT_METADATA_BYTES) {
    throw new Error('client metadata document is too large')
  }

  const metadata = oauthClientMetadataSchema.parse(JSON.parse(body))
  if (metadata.client_id !== clientId) {
    throw new Error('client metadata document does not match its client_id')
  }

  return metadata.redirect_uris
}

export interface RedirectTargetGates {
  allowedSchemes: string[]
  allowedRedirectOrigins: string[]
  devMode: boolean
}

export type RedirectTargetVerdict =
  | { allowed: true }
  | { allowed: false; message: string }

const PROOF_REQUIRED_MESSAGE =
  'redirect_uri is not declared by a client_id metadata document and its origin is not allow-listed'

/**
 * Decide whether the enrollment flow may return the browser to a
 * caller-supplied URL.
 *
 * A caller proves the target belongs to it by publishing a client metadata
 * document and naming it with `client_id`, the same self-published trust
 * anchor AT Protocol uses for OAuth clients. The operator allow-list is a
 * second, optional route for a caller that publishes no such document. Neither
 * route needs operator configuration for a caller that publishes one, so a new
 * client can onboard itself.
 *
 * Origins are compared, not full URLs. An open redirect is a question of which
 * host receives the browser, and the allow-list is origin-scoped too.
 *
 * @param redirectUri - The return URL supplied by the caller
 * @param clientId - The caller's `client_id`, if it supplied one
 * @param gates - Permitted schemes, allow-listed origins, and the dev-mode flag
 * @param fetchRedirectUris - Client metadata reader; injected for tests
 * @returns Whether the redirect is permitted, with a reason when it is not
 */
export async function verifyRedirectTarget(
  redirectUri: string,
  clientId: string | undefined,
  gates: RedirectTargetGates,
  fetchRedirectUris: (
    clientId: string,
  ) => Promise<string[]> = fetchClientRedirectUris,
): Promise<RedirectTargetVerdict> {
  let target: URL
  try {
    target = new URL(redirectUri)
  } catch {
    return { allowed: false, message: 'Invalid redirect_uri' }
  }

  if (!gates.allowedSchemes.includes(target.protocol)) {
    return { allowed: false, message: 'redirect_uri must use https' }
  }

  if (isAllowedRedirectOrigin(redirectUri, gates)) {
    return { allowed: true }
  }

  if (!clientId) {
    return { allowed: false, message: PROOF_REQUIRED_MESSAGE }
  }

  let declared: string[]
  try {
    declared = await fetchRedirectUris(clientId)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      allowed: false,
      message: `could not verify redirect_uri against client_id: ${reason}`,
    }
  }

  const declaresTarget = declared.some((uri) => {
    try {
      return new URL(uri).origin === target.origin
    } catch {
      return false
    }
  })

  return declaresTarget
    ? { allowed: true }
    : {
        allowed: false,
        message: 'redirect_uri origin is not declared by the client_id',
      }
}
