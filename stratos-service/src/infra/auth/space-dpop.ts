import { DpopManager, type DpopProof } from '@atproto/oauth-provider'
import type { VerifyRequestContext } from './dpop-verifier.js'

/** Thrown when a space-surface DPoP proof is missing or fails validation. */
export class SpaceDpopProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpaceDpopProofError'
  }
}

/**
 * RFC 9449 proof checker for the space surface (credential mint and
 * presentation).
 *
 * Nonces are deliberately disabled (`dpopSecret: false`): the upstream space
 * surface uses plain per-request proofs with a short freshness window, not the
 * OAuth nonce round trip. The wrapped `DpopManager.checkProof` verifies the
 * proof signature (embedded JWK), `typ`, `iat` freshness, `jti` presence, and
 * the `htm`/`htu` request binding. When `boundToken` is supplied it REQUIRES
 * `ath` = b64url(SHA-256(boundToken)); when omitted it REJECTS any `ath`
 * (mint-time proofs are not token-bound). Replay (`jti`) consumption is the
 * caller's responsibility — a proof that fails later checks must not burn its
 * nonce.
 */
export class SpaceDpopProofChecker {
  private readonly manager = new DpopManager({ dpopSecret: false })

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
  ): Promise<DpopProof> {
    const url = new URL(req.url, this.serviceEndpoint)
    let proof: DpopProof | null
    try {
      proof = await this.manager.checkProof(
        req.method,
        url,
        req.headers,
        boundToken,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid DPoP proof'
      throw new SpaceDpopProofError(message)
    }
    if (!proof) {
      throw new SpaceDpopProofError('DPoP proof required')
    }
    return proof
  }
}
