/**
 * DPoP Token Verifier
 *
 * Verifies DPoP-bound access tokens using the PDS's JWKS.
 * Follows RFC 9449 for DPoP proof validation.
 */
import { DpopManager, type DpopProof } from '@atproto/oauth-provider'
import type {
  EnrollmentStoreReader,
  Logger,
} from '@northskysocial/stratos-core'
import {
  PdsTokenVerifier,
  type TokenVerificationResult,
  type VerifiedTokenClaims,
} from './introspection-client.js'

/**
 * Result of successful DPoP verification
 */
export interface DpopAuthResult {
  type: 'dpop'
  did: string
  scope: string
  pdsEndpoint: string
  tokenType: 'DPoP'
}

/**
 * Configuration for DPoP verifier
 */
export interface DpopVerifierConfig {
  /** This Stratos service's DID */
  serviceDid: string
  /** This Stratos service's endpoint URL */
  serviceEndpoint: string
  /** Token verifier for validating access tokens */
  tokenVerifier: PdsTokenVerifier
  /** Enrollment store for checking enrollment status */
  enrollmentStore: EnrollmentStoreReader
  /** DPoP secret for nonce generation (false to disable, undefined for random) */
  dpopSecret?: Uint8Array | string | false
  /** DPoP nonce rotation interval in ms */
  dpopRotationInterval?: number
  /** Logger for auth events */
  logger?: Logger
}

/**
 * Error thrown when DPoP verification fails
 */
export class DpopVerificationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'missing_auth'
      | 'invalid_token'
      | 'invalid_dpop_proof'
      | 'use_dpop_nonce'
      | 'token_inactive'
      | 'key_binding_mismatch'
      | 'not_enrolled'
      | 'verification_failed',
    public readonly wwwAuthenticate?: string,
  ) {
    super(message)
    this.name = 'DpopVerificationError'
  }
}

/**
 * Request context for verification
 */
export interface VerifyRequestContext {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

/**
 * Response context for setting headers
 */
export interface VerifyResponseContext {
  setHeader(name: string, value: string): void
}

/**
 * DPoP Token Verifier
 *
 * Verifies DPoP-bound OAuth access tokens by:
 * 1. Checking for DPoP authorization header and proof
 * 2. Validating the DPoP proof (signature, claims, etc.)
 * 3. Verifying the token signature using the PDS's JWKS
 * 4. Verifying the token is bound to the DPoP proof key
 * 5. Checking the user is enrolled
 */
export class DpopVerifier {
  private readonly dpopManager: DpopManager
  private readonly config: DpopVerifierConfig

  constructor(config: DpopVerifierConfig) {
    this.config = config
    this.dpopManager = new DpopManager({
      dpopSecret: config.dpopSecret as
        | Uint8Array<ArrayBuffer>
        | string
        | false
        | undefined,
      dpopRotationInterval: config.dpopRotationInterval,
    })
  }

  /**
   * Get a DPoP nonce for response header
   */
  nextNonce(): string | undefined {
    return this.dpopManager.nextNonce()
  }

  /**
   * Verify a DPoP-authenticated request
   *
   * @param req - Request context
   * @param res - Optional response context for setting DPoP-Nonce header
   * @returns Verification result with user DID and scope
   * @throws DpopVerificationError if verification fails
   */
  async verify(
    req: VerifyRequestContext,
    res?: VerifyResponseContext,
  ): Promise<DpopAuthResult> {
    const start = Date.now()
    this.config.logger?.debug(
      { method: req.method, url: req.url },
      'DPoP auth attempt',
    )

    // Set DPoP-Nonce header for client
    const nonce = this.nextNonce()
    if (nonce && res) {
      res.setHeader('DPoP-Nonce', nonce)
    }

    // Parse Authorization header
    const authHeader = this.getHeader(req.headers, 'authorization')
    if (!authHeader) {
      this.config.logger?.warn(
        { code: 'missing_auth' },
        'DPoP auth failed: missing authorization header',
      )
      throw new DpopVerificationError(
        'Authorization header required',
        'missing_auth',
        'DPoP realm="stratos"',
      )
    }

    // Must be DPoP scheme
    if (!authHeader.startsWith('DPoP ')) {
      this.config.logger?.warn(
        { code: 'missing_auth' },
        'DPoP auth failed: non-DPoP scheme',
      )
      throw new DpopVerificationError(
        'DPoP authorization required',
        'missing_auth',
        'DPoP realm="stratos"',
      )
    }

    const accessToken = authHeader.slice(5).trim()
    if (!accessToken) {
      throw new DpopVerificationError(
        'Access token required',
        'invalid_token',
        'DPoP realm="stratos", error="invalid_token"',
      )
    }

    // Build request URL
    const url = new URL(req.url, this.config.serviceEndpoint)

    // Validate DPoP proof
    let dpopProof: DpopProof | null
    try {
      dpopProof = await this.dpopManager.checkProof(
        req.method,
        url,
        req.headers as Record<string, string | string[] | undefined>,
        accessToken,
      )
    } catch (err) {
      if (isUseDpopNonceError(err)) {
        this.config.logger?.debug('DPoP nonce required, sending use_dpop_nonce')
        throw new DpopVerificationError(
          'DPoP nonce required',
          'use_dpop_nonce',
          'DPoP error="use_dpop_nonce"',
        )
      }
      const message = err instanceof Error ? err.message : 'Invalid DPoP proof'
      this.config.logger?.warn(
        { code: 'invalid_dpop_proof', error: message },
        'DPoP auth failed: invalid proof',
      )
      throw new DpopVerificationError(
        message,
        'invalid_dpop_proof',
        `DPoP realm="stratos", error="invalid_dpop_proof", error_description="${message}"`,
      )
    }

    // DPoP proof is required for DPoP token type
    if (!dpopProof) {
      this.config.logger?.warn(
        { code: 'invalid_dpop_proof' },
        'DPoP auth failed: proof missing',
      )
      throw new DpopVerificationError(
        'DPoP proof required',
        'invalid_dpop_proof',
        'DPoP realm="stratos", error="invalid_dpop_proof"',
      )
    }

    // Verify token using PDS JWKS
    let verificationResult: TokenVerificationResult
    try {
      verificationResult = await this.config.tokenVerifier.verify(accessToken)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Token verification failed'
      this.config.logger?.error(
        { code: 'verification_failed', error: message },
        'DPoP auth failed: token verification error',
      )
      throw new DpopVerificationError(message, 'verification_failed')
    }

    // Check token is active/valid
    if (!verificationResult.active) {
      this.config.logger?.warn(
        { code: 'token_inactive', error: verificationResult.error },
        'DPoP auth failed: token inactive',
      )
      throw new DpopVerificationError(
        verificationResult.error ?? 'Token is not active',
        'token_inactive',
        'DPoP realm="stratos", error="invalid_token"',
      )
    }

    // Token is verified - cast to claims type
    const claims = verificationResult as VerifiedTokenClaims

    if (!claims.signatureVerified) {
      this.config.logger?.warn(
        { did: claims.sub },
        'token signature not verified (PDS uses symmetric signing); relying on DPoP proof binding',
      )
    }

    // Get subject (user DID)
    const did = claims.sub
    if (!did || !did.startsWith('did:')) {
      this.config.logger?.warn(
        { code: 'invalid_token' },
        'DPoP auth failed: invalid subject',
      )
      throw new DpopVerificationError(
        'Invalid subject in token',
        'invalid_token',
      )
    }

    // Get PDS endpoint from issuer
    const pdsEndpoint = claims.iss

    // Verify DPoP key binding
    // The token's cnf.jkt must match the DPoP proof's JWK thumbprint
    const tokenJkt = claims.cnf?.jkt
    if (tokenJkt) {
      if (tokenJkt !== dpopProof.jkt) {
        this.config.logger?.warn(
          { did, code: 'key_binding_mismatch' },
          'DPoP auth failed: key binding mismatch',
        )
        throw new DpopVerificationError(
          'DPoP key binding mismatch',
          'key_binding_mismatch',
          'DPoP realm="stratos", error="invalid_dpop_proof"',
        )
      }
    }

    // Check user is enrolled
    const isEnrolled = await this.config.enrollmentStore.isEnrolled(did)
    if (!isEnrolled) {
      this.config.logger?.warn(
        { did, code: 'not_enrolled' },
        'DPoP auth failed: user not enrolled',
      )
      throw new DpopVerificationError(
        `User ${did} is not enrolled`,
        'not_enrolled',
      )
    }

    this.config.logger?.debug(
      { did, durationMs: Date.now() - start },
      'DPoP auth succeeded',
    )

    return {
      type: 'dpop',
      did,
      scope: claims.scope ?? 'atproto',
      pdsEndpoint,
      tokenType: 'DPoP',
    }
  }

  /**
   * Get a header value (handles arrays)
   */
  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = headers[name] ?? headers[name.toLowerCase()]
    if (Array.isArray(value)) {
      return value[0]
    }
    return value
  }
}

// OAuthError.error === 'use_dpop_nonce' identifies the nonce-required error
// from @atproto/oauth-provider without needing to import the unexported class
function isUseDpopNonceError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'error' in err &&
    (err as Record<string, unknown>).error === 'use_dpop_nonce'
  )
}
