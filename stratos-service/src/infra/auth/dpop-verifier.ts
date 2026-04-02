/**
 * DPoP Token Verifier
 *
 * Verifies DPoP-bound access tokens.
 * Follows RFC 9449 for DPoP proof validation.
 */
import { DpopManager, type DpopProof } from '@atproto/oauth-provider'
import jwt from 'jsonwebtoken'
import type {
  EnrollmentStoreReader,
  Logger,
} from '@northskysocial/stratos-core'
import { ExternalAllowListProvider } from '../../features/enrollment/internal/allow-list.js'

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
  /** Enrollment store for checking enrollment status */
  enrollmentStore: EnrollmentStoreReader
  /** Optional allowlist provider */
  allowListProvider?: ExternalAllowListProvider
  /** Optional DPoP manager for testing */
  dpopManager?: DpopManager
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
      | 'not_allowed',
    public readonly wwwAuthenticate?: string,
  ) {
    super(message)
    this.name = 'DpopVerificationError'
  }
}

/**
 * Header values can be a single string, an array of strings, or undefined
 */
export type HeaderValue = string | string[] | undefined

/**
 * Request headers type alias
 */
export type RequestHeaders = Record<string, HeaderValue>

/**
 * Request context for verification
 */
export interface VerifyRequestContext {
  method: string
  url: string
  headers: RequestHeaders
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
 * 3. Decoding JWT claims (signature verification is not possible — PDS does not expose JWKS)
 * 4. Verifying the token is bound to the DPoP proof key
 * 5. Checking the user is enrolled
 */
export class DpopVerifier {
  private readonly dpopManager: DpopManager
  private readonly config: DpopVerifierConfig

  constructor(config: DpopVerifierConfig) {
    this.config = config
    this.dpopManager =
      config.dpopManager ??
      new DpopManager({
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
   *
   * @returns DPoP nonce or undefined if nonce rotation is disabled
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

    const accessToken = this.parseAccessToken(req)
    const dpopProof = await this.validateDpopProof(req, accessToken)
    const claims = this.decodeAndValidateClaims(accessToken)
    const did = claims.sub as string
    const pdsEndpoint = claims.iss as string

    this.verifyKeyBinding(claims, dpopProof)
    await this.checkEnrollmentAndAllowList(did)

    // Set DPoP-Nonce header for client after successful verification
    const nonce = this.nextNonce()
    if (nonce && res) {
      res.setHeader('DPoP-Nonce', nonce)
    }

    this.config.logger?.debug(
      { did, durationMs: Date.now() - start },
      'DPoP auth succeeded',
    )

    return {
      type: 'dpop',
      did,
      scope: (claims.scope as string) ?? 'atproto',
      pdsEndpoint,
      tokenType: 'DPoP',
    }
  }

  /**
   * Parse and validate the Authorization header
   *
   * @param req - The request context
   * @returns The access token from the Authorization header
   * @private
   */
  private parseAccessToken(req: VerifyRequestContext): string {
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

    return accessToken
  }

  /**
   * Validate the DPoP proof
   *
   * @param req - The request context
   * @param accessToken - The access token
   * @returns The validated DPoP proof
   * @throws {DpopVerificationError} if the proof is invalid or missing
   * @private
   */
  private async validateDpopProof(
    req: VerifyRequestContext,
    accessToken: string,
  ): Promise<DpopProof> {
    const url = new URL(req.url, this.config.serviceEndpoint)
    let dpopProof: DpopProof | null
    try {
      dpopProof = await this.dpopManager.checkProof(
        req.method,
        url,
        req.headers,
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

    return dpopProof
  }

  /**
   * Decode and validate JWT claims
   *
   * @param accessToken - The access token to decode and validate
   * @returns The decoded JWT claims
   * @throws {DpopVerificationError} if the token is invalid or expired
   */
  private decodeAndValidateClaims(accessToken: string): jwt.JwtPayload {
    const claims = jwt.decode(accessToken, { json: true })
    if (!claims) {
      this.config.logger?.warn(
        { code: 'invalid_token' },
        'DPoP auth failed: could not decode JWT',
      )
      throw new DpopVerificationError(
        'Could not decode access token',
        'invalid_token',
        'DPoP realm="stratos", error="invalid_token"',
      )
    }

    if (claims.exp !== undefined) {
      const nowSec = Math.floor(Date.now() / 1000)
      if (nowSec > claims.exp + 30) {
        this.config.logger?.warn(
          { code: 'token_inactive' },
          'DPoP auth failed: token expired',
        )
        throw new DpopVerificationError(
          'Token expired',
          'token_inactive',
          'DPoP realm="stratos", error="invalid_token"',
        )
      }
    }

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

    if (!claims.iss) {
      this.config.logger?.warn(
        { did, code: 'invalid_token' },
        'DPoP auth failed: missing issuer',
      )
      throw new DpopVerificationError(
        'Token missing issuer (iss) claim',
        'invalid_token',
      )
    }

    return claims
  }

  /**
   * Verify DPoP key binding
   *
   * @param claims - JWT claims
   * @param dpopProof - DPoP proof
   * @throws {DpopVerificationError} if key binding fails
   */
  private verifyKeyBinding(claims: jwt.JwtPayload, dpopProof: DpopProof): void {
    const tokenJkt = (claims.cnf as { jkt?: string } | undefined)?.jkt
    if (tokenJkt && tokenJkt !== dpopProof.jkt) {
      this.config.logger?.warn(
        { did: claims.sub, code: 'key_binding_mismatch' },
        'DPoP auth failed: key binding mismatch',
      )
      throw new DpopVerificationError(
        'DPoP key binding mismatch',
        'key_binding_mismatch',
        'DPoP realm="stratos", error="invalid_dpop_proof"',
      )
    }
  }

  /**
   * Check user enrollment and allowlist
   *
   * @param did - User DID
   * @throws {DpopVerificationError} if user is not enrolled or not on allowlist
   */
  private async checkEnrollmentAndAllowList(did: string): Promise<void> {
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

    if (this.config.allowListProvider) {
      const isAllowed = await this.config.allowListProvider.isAllowed(did)
      if (!isAllowed) {
        this.config.logger?.warn(
          { did, code: 'not_allowed' },
          'DPoP auth failed: user not on allowlist',
        )
        throw new DpopVerificationError(
          `User ${did} is not on the allowlist`,
          'not_allowed',
        )
      }
    }
  }

  /**
   * Get a header value (handles arrays)
   *
   * @param headers - Request headers
   * @param name - Header name
   * @returns Header value or undefined if not found
   */
  private getHeader(headers: RequestHeaders, name: string): string | undefined {
    const value = headers[name] ?? headers[name.toLowerCase()]
    if (Array.isArray(value)) {
      return value[0]
    }
    return value
  }
}

/**
 * Check if error is a use_dpop_nonce error.
 * AuthError.error === 'use_dpop_nonce' identifies the nonce-required error
 * from @atproto/oauth-provider without needing to import the unexported class
 *
 * @param err - Error object
 * @returns true if error is a use_dpop_nonce error, false otherwise
 */
function isUseDpopNonceError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'error' in err &&
    (err as Record<string, unknown>).error === 'use_dpop_nonce'
  )
}
