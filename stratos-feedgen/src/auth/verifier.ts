import type { IdResolver } from '@atproto/identity'
import { AuthRequiredError } from '@atproto/xrpc-server'
import { verifyJwt } from '@atproto/xrpc-server'

/** Headers carried on an inbound feed-generator request. */
export interface RequestHeaders {
  authorization?: string | string[]
  [key: string]: unknown
}

/** Minimal shape of an inbound request, covering Node `IncomingMessage`. */
export interface IncomingFeedRequest {
  headers: RequestHeaders
}

/** Successful verification result. */
export interface VerifiedFeedRequest {
  /** Issuer DID extracted from the JWT — the viewer the call is on behalf of. */
  viewerDid: string
  /** The `lxm` value carried on the JWT (already validated against the allow-list). */
  lxm: string
}

export interface FeedRequestVerifierDeps {
  /** Expected `aud` value — this feed generator's own DID. */
  feedgenDid: string
  /** Lxms accepted on inbound JWTs. */
  allowedLxms: readonly string[]
  /** Identity resolver used to fetch the issuer's signing key. */
  idResolver: IdResolver
}

export type FeedRequestVerifier = (
  req: IncomingFeedRequest,
) => Promise<VerifiedFeedRequest>

/**
 * Build a verifier for inbound service-auth JWTs.
 *
 * The returned function validates the `Authorization: Bearer` header against:
 *
 *   - `typ` block-list (`at+jwt`, `dpop+jwt`, `refresh+jwt`)
 *   - `exp` not in the past
 *   - `aud === feedgenDid`
 *   - `lxm` in `allowedLxms`
 *   - signature against the issuer's atproto verification key
 *
 * Signature, `aud`, `exp`, and `typ` checks are delegated to
 * `@atproto/xrpc-server`'s `verifyJwt`. The lxm allow-list is enforced
 * here so callers can permit multiple methods (verifyJwt only takes one).
 */
export function createFeedRequestVerifier(
  deps: FeedRequestVerifierDeps,
): FeedRequestVerifier {
  const { feedgenDid, allowedLxms, idResolver } = deps

  const getSigningKey = async (
    iss: string,
    forceRefresh: boolean,
  ): Promise<string> => {
    try {
      return await idResolver.did.resolveAtprotoKey(iss, forceRefresh)
    } catch (err) {
      throw new AuthRequiredError(
        `could not resolve issuer did: ${iss}`,
        'CouldNotResolveIssuer',
        { cause: err },
      )
    }
  }

  return async (req) => {
    const token = extractBearerToken(req.headers)

    let payload
    try {
      payload = await verifyJwt(token, feedgenDid, null, getSigningKey)
    } catch (err) {
      if (
        err instanceof AuthRequiredError &&
        (err as { customErrorName?: string }).customErrorName === 'JwtExpired'
      ) {
        throw new AuthRequiredError('jwt expired', 'ExpiredToken', {
          cause: err,
        })
      }
      throw err
    }

    if (!payload.lxm || !allowedLxms.includes(payload.lxm)) {
      throw new AuthRequiredError(
        payload.lxm
          ? `bad jwt lexicon method ("lxm"): ${payload.lxm}`
          : 'missing jwt lexicon method ("lxm")',
        'BadJwtLexiconMethod',
      )
    }

    return { viewerDid: payload.iss, lxm: payload.lxm }
  }
}

function extractBearerToken(headers: RequestHeaders): string {
  const raw = headers.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) {
    throw new AuthRequiredError('missing authorization header', 'AuthMissing')
  }
  const [scheme, token, ...rest] = value.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
    throw new AuthRequiredError(
      'invalid authorization scheme; expected Bearer',
      'InvalidToken',
    )
  }
  return token
}
