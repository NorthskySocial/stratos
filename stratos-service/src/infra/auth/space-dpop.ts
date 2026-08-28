import { createHash } from 'node:crypto'
import { EmbeddedJWK, calculateJwkThumbprint, jwtVerify } from 'jose'
import type { VerifyRequestContext } from './dpop-verifier.js'

/**
 * RFC 9449 proof checker for the space surface (credential mint and
 * presentation).
 *
 * This is a standalone implementation that mirrors the upstream space-surface
 * checker (`@atproto/space` `dpop.ts`) rather than wrapping the OAuth
 * provider's `DpopManager`. The manager cannot serve this surface: with
 * nonces disabled it REJECTS any proof that carries a `nonce` claim, and its
 * freshness window (10s age + 180s tolerance) is both looser than the spec's
 * and impossible to derive a replay TTL from. Here the space rules apply:
 *   - `typ` MUST be `dpop+jwt`, `alg` MUST be ES256, key embedded via `jwk`.
 *   - `iat` MUST be within {@link SPACE_DPOP_MAX_PROOF_AGE_SEC} (plus
 *     {@link SPACE_DPOP_CLOCK_SKEW_SEC} tolerance).
 *   - `jti` MUST be present; `htm`/`htu` MUST match the request.
 *   - A `nonce` claim is IGNORED: the space surface uses plain per-request
 *     proofs with server-side `jti` replay tracking, not the OAuth nonce
 *     round trip.
 *   - When `boundToken` is supplied, `ath` MUST equal
 *     b64url(SHA-256(boundToken)); when omitted, `ath` MUST be absent
 *     (mint-time proofs are not token-bound).
 * Replay (`jti`) consumption is the caller's responsibility — a proof that
 * fails later checks must not burn its nonce.
 */

/** Longest accepted proof age (`iat` to now), in seconds. */
export const SPACE_DPOP_MAX_PROOF_AGE_SEC = 60
/** Clock-skew tolerance for `iat`, in seconds. */
export const SPACE_DPOP_CLOCK_SKEW_SEC = 5

const DPOP_PROOF_TYP = 'dpop+jwt'
const SIGNING_ALG = 'ES256'

/** Thrown when a space-surface DPoP proof is missing or fails validation. */
export class SpaceDpopProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpaceDpopProofError'
  }
}

/** A validated space-surface DPoP proof. */
export interface SpaceDpopProof {
  jti: string
  jkt: string
  htm: string
  htu: string
}

export class SpaceDpopProofChecker {
  /**
   * @param serviceEndpoint - This service's public base URL, used to resolve
   *   the request path into the absolute URL that `htu` must match.
   */
  constructor(private readonly serviceEndpoint: string) {}

  /**
   * Validate the request's `DPoP` header proof.
   *
   * @param req - Request context (method, url, headers).
   * @param boundToken - The token the proof must hash-bind via `ath`, if any.
   * @returns The validated proof (`jti`, `jkt`, `htm`, `htu`).
   * @throws SpaceDpopProofError when the header is absent or the proof is
   *   invalid.
   */
  async check(
    req: VerifyRequestContext,
    boundToken?: string,
  ): Promise<SpaceDpopProof> {
    const proofJwt = extractProofHeader(req.headers)
    if (!proofJwt) {
      throw new SpaceDpopProofError('DPoP proof required')
    }

    // EmbeddedJWK verifies against the proof's own `jwk` header; the caller's
    // thumbprint comparison is what ties that key to a credential.
    const { protectedHeader, payload } = await jwtVerify(
      proofJwt,
      EmbeddedJWK,
      {
        typ: DPOP_PROOF_TYP,
        algorithms: [SIGNING_ALG],
        maxTokenAge: SPACE_DPOP_MAX_PROOF_AGE_SEC,
        clockTolerance: SPACE_DPOP_CLOCK_SKEW_SEC,
      },
    ).catch((err) => {
      throw new SpaceDpopProofError(
        `could not verify DPoP proof: ${errMsg(err)}`,
      )
    })

    const { jti, htm, htu, ath } = payload
    if (typeof jti !== 'string' || !jti) {
      throw new SpaceDpopProofError('missing DPoP proof "jti"')
    }
    if (htm !== req.method) {
      throw new SpaceDpopProofError(
        'DPoP proof "htm" does not match the request',
      )
    }
    const expectedHtu = this.expectedHtu(req.url)
    if (typeof htu !== 'string' || htu !== expectedHtu) {
      // Name both sides. A mismatch here is a deployment problem, not an
      // attack, and without the values it takes a rebuild to find out which
      // URL was wrong.
      throw new SpaceDpopProofError(
        `DPoP proof "htu" does not match the request: proof=${String(htu)} expected=${expectedHtu}`,
      )
    }
    if (boundToken !== undefined) {
      if (ath !== hashToken(boundToken)) {
        throw new SpaceDpopProofError(
          'DPoP proof "ath" does not match the credential',
        )
      }
    } else if (ath !== undefined) {
      throw new SpaceDpopProofError(
        'DPoP proof "ath" must be omitted when obtaining a credential',
      )
    }

    // Present because jwtVerify used EmbeddedJWK.
    const jkt = await calculateJwkThumbprint(
      protectedHeader.jwk!,
      'sha256',
    ).catch((err) => {
      throw new SpaceDpopProofError(
        `could not compute DPoP key thumbprint: ${errMsg(err)}`,
      )
    })

    return { jti, jkt, htm, htu }
  }

  // Strips query and fragment (RFC 9449 section 4.2), so one proof covers any
  // query on a path.
  private expectedHtu(requestUrl: string): string {
    try {
      const url = new URL(requestUrl, this.serviceEndpoint)
      return url.origin + url.pathname
    } catch (err) {
      throw new SpaceDpopProofError(
        `could not resolve the request URL: ${errMsg(err)}`,
      )
    }
  }
}

function extractProofHeader(
  headers: Record<string, undefined | string | string[]>,
): string | null {
  const value = headers['dpop']
  if (value === undefined) return null
  if (typeof value === 'string') {
    if (value) return value
    throw new SpaceDpopProofError('DPoP header must not be empty')
  }
  if (value.length === 1 && value[0]) return value[0]
  throw new SpaceDpopProofError('DPoP header must contain a single proof')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
