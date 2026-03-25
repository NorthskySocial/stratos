/**
 * PDS Token Verifier
 *
 * Validates OAuth access tokens by decoding JWT claims and verifying the
 * issuer matches the user's PDS endpoint (resolved from their DID document).
 *
 * Bluesky's PDS does not expose signing keys at the JWKS endpoint, so
 * cryptographic signature verification is not possible for Bluesky users.
 * Authentication assurance comes from DPoP proof binding (RFC 9449) instead.
 */
import { IdResolver } from '@atproto/identity'

/**
 * Verified token claims
 */
export interface VerifiedTokenClaims {
  /** Token is valid */
  active: true
  /** Subject (user DID) */
  sub: string
  /** Issuer (PDS URL) */
  iss: string
  /** Audience */
  aud?: string | string[]
  /** Expiration timestamp */
  exp?: number
  /** Issued at timestamp */
  iat?: number
  /** JWT ID */
  jti?: string
  /** Scope */
  scope?: string
  /** Client ID */
  client_id?: string
  /** DPoP bound key confirmation (RFC 9449) */
  cnf?: {
    /** JWK SHA-256 Thumbprint */
    jkt?: string
  }
}

/**
 * Result of token verification
 */
export type TokenVerificationResult =
  | VerifiedTokenClaims
  | { active: false; error?: string }

/**
 * Interface for token verification
 */
export interface TokenVerifier {
  /**
   * Verify an access token
   * @param token - The access token (JWT)
   * @returns Verified token claims or inactive result
   */
  verify(token: string): Promise<TokenVerificationResult>
}

/**
 * Configuration for PDS token verifier
 */
export interface PdsTokenVerifierConfig {
  /** Identity resolver for looking up PDS endpoints */
  idResolver: IdResolver
  /** Expected audience (this service's URL) - if set, tokens must include this */
  audience?: string
  /** Maximum age of cached verification results in ms (default: 60 seconds) */
  verifyCacheMaxAge?: number
  /** Maximum number of cached verification results (default: 1000) */
  verifyCacheMaxSize?: number
}

interface VerifyCacheEntry {
  result: TokenVerificationResult
  cachedAt: number
}

/**
 * Verifies OAuth access tokens by decoding claims and validating the issuer
 * against the user's DID document.
 *
 * Does NOT verify JWT signatures — Bluesky's PDS does not expose signing
 * keys via JWKS. DPoP proof binding provides authentication assurance.
 */
export class PdsTokenVerifier implements TokenVerifier {
  private readonly idResolver: IdResolver
  private readonly audience?: string
  private readonly verifyCacheMaxAge: number
  private readonly verifyCacheMaxSize: number

  /** Cache of verification results by access token */
  private readonly verifyCache = new Map<string, VerifyCacheEntry>()

  constructor(config: PdsTokenVerifierConfig) {
    this.idResolver = config.idResolver
    this.audience = config.audience
    this.verifyCacheMaxAge = config.verifyCacheMaxAge ?? 60 * 1000
    this.verifyCacheMaxSize = config.verifyCacheMaxSize ?? 1_000
  }

  /**
   * Get the PDS endpoint for a DID by resolving its DID document
   */
  async getPdsEndpointFromDid(did: string): Promise<string | null> {
    try {
      const didDoc = await this.idResolver.did.resolve(did)
      if (!didDoc) return null

      const services = didDoc.service ?? []
      for (const service of services) {
        if (
          service.id === '#atproto_pds' ||
          service.id === `${did}#atproto_pds`
        ) {
          if (typeof service.serviceEndpoint === 'string') {
            return service.serviceEndpoint
          }
        }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Verify an access token
   */
  async verify(token: string): Promise<TokenVerificationResult> {
    const cached = this.verifyCache.get(token)
    if (cached) {
      const age = Date.now() - cached.cachedAt
      if (age < this.verifyCacheMaxAge) {
        if (cached.result.active && cached.result.exp !== undefined) {
          const nowSec = Math.floor(Date.now() / 1000)
          if (nowSec > cached.result.exp + 30) {
            this.verifyCache.delete(token)
          } else {
            return cached.result
          }
        } else {
          return cached.result
        }
      } else {
        this.verifyCache.delete(token)
      }
    }

    const result = await this.verifyUncached(token)

    if (result.active) {
      this.verifyCache.set(token, { result, cachedAt: Date.now() })
      this.evictVerifyCache()
    }

    return result
  }

  private evictVerifyCache(): void {
    if (this.verifyCache.size <= this.verifyCacheMaxSize) return
    const now = Date.now()
    for (const [key, entry] of this.verifyCache) {
      if (now - entry.cachedAt >= this.verifyCacheMaxAge) {
        this.verifyCache.delete(key)
      }
    }
    if (this.verifyCache.size > this.verifyCacheMaxSize) {
      const excess = this.verifyCache.size - this.verifyCacheMaxSize
      let removed = 0
      for (const key of this.verifyCache.keys()) {
        if (removed >= excess) break
        this.verifyCache.delete(key)
        removed++
      }
    }
  }

  private async verifyUncached(
    token: string,
  ): Promise<TokenVerificationResult> {
    // 1. Decode token claims (no signature verification)
    let payload: Record<string, unknown>
    try {
      const parts = token.split('.')
      if (parts.length !== 3) {
        return { active: false, error: 'Invalid JWT format' }
      }
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      return { active: false, error: 'Failed to decode JWT payload' }
    }

    const sub = payload['sub'] as string | undefined
    const iss = payload['iss'] as string | undefined

    // 2. Validate subject is a DID
    if (!sub || !sub.startsWith('did:')) {
      return { active: false, error: 'Invalid subject claim' }
    }

    if (!iss) {
      return { active: false, error: 'Token missing issuer (iss) claim' }
    }

    // 3. Validate issuer is a URL
    let issuerOrigin: string
    try {
      issuerOrigin = new URL(iss).origin
    } catch {
      return { active: false, error: `Invalid issuer URL: ${iss}` }
    }

    // 4. Resolve the user's DID to find their PDS endpoint
    const pdsEndpoint = await this.getPdsEndpointFromDid(sub)
    if (!pdsEndpoint) {
      return {
        active: false,
        error: `Could not resolve PDS endpoint for ${sub}`,
      }
    }

    // 5. Verify issuer matches the user's PDS
    const pdsOrigin = new URL(pdsEndpoint).origin
    if (issuerOrigin !== pdsOrigin) {
      return {
        active: false,
        error: `Issuer ${issuerOrigin} does not match PDS ${pdsOrigin}`,
      }
    }

    // 6. Check expiration
    const exp = payload['exp'] as number | undefined
    if (exp !== undefined) {
      const nowSec = Math.floor(Date.now() / 1000)
      if (nowSec > exp + 30) {
        return { active: false, error: 'Token expired' }
      }
    }

    // 7. Check audience if configured
    if (this.audience) {
      const aud = payload['aud'] as string | string[] | undefined
      const audArray = Array.isArray(aud) ? aud : aud ? [aud] : []
      if (!audArray.includes(this.audience)) {
        return { active: false, error: 'Audience mismatch' }
      }
    }

    return {
      active: true,
      sub,
      iss,
      aud: payload['aud'] as string | string[] | undefined,
      exp,
      iat: payload['iat'] as number | undefined,
      jti: payload['jti'] as string | undefined,
      scope: payload['scope'] as string | undefined,
      client_id: payload['client_id'] as string | undefined,
      cnf: payload['cnf'] as { jkt?: string } | undefined,
    }
  }

  /**
   * Clear all caches (useful for testing)
   */
  clearCache(): void {
    this.verifyCache.clear()
  }
}

/**
 * @deprecated Use PdsTokenVerifier instead
 */
export const PdsIntrospectionClient = PdsTokenVerifier
export type IntrospectionResponse = VerifiedTokenClaims
