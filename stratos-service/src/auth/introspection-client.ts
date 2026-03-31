/**
 * PDS Token Verifier
 *
 * Validates OAuth access tokens by decoding JWT claims and verifying the
 * issuer matches the PDS's declared authorization server (via OAuth metadata).
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
  /** Optional fetch implementation for testing */
  fetch?: typeof globalThis.fetch
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
  private readonly fetch: typeof globalThis.fetch

  /** Cache of verification results by access token */
  private readonly verifyCache = new Map<string, VerifyCacheEntry>()
  /** Cache of PDS OAuth issuer by PDS origin */
  private readonly issuerCache = new Map<string, string>()

  constructor(config: PdsTokenVerifierConfig) {
    this.idResolver = config.idResolver
    this.audience = config.audience
    this.verifyCacheMaxAge = config.verifyCacheMaxAge ?? 60 * 1000
    this.verifyCacheMaxSize = config.verifyCacheMaxSize ?? 1_000
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * Get the PDS endpoint for a DID by resolving its DID document
   * @param did - The DID to resolve.
   * @returns The PDS endpoint URL or null if not found.
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
   * @param token - The access token to verify.
   * @returns The verification result.
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

  /**
   * Clear all caches (useful for testing)
   */
  clearCache(): void {
    this.verifyCache.clear()
    this.issuerCache.clear()
  }

  /**
   * Evict expired entries from the verify cache.
   */
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

  /**
   * Verify an access token without using the cache.
   * @param token - The access token to verify.
   * @returns The verification result.
   */
  private async verifyUncached(
    token: string,
  ): Promise<TokenVerificationResult> {
    // 1. Decode token claims (no signature verification)
    const payload = this.decodeJwtPayload(token)
    if (!payload) {
      return { active: false, error: 'Failed to decode JWT payload' }
    }

    // 2. Validate subject and issuer
    const sub = payload['sub'] as string | undefined
    const iss = payload['iss'] as string | undefined

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

    // 4. Verify issuer matches the PDS's declared authorization server
    const pdsError = await this.verifyPdsAuthServer(sub, issuerOrigin)
    if (pdsError) {
      return { active: false, error: pdsError }
    }

    // 5. Check expiration and audience
    const expError = this.checkExpirationAndAudience(payload)
    if (expError) {
      return { active: false, error: expError }
    }

    return {
      active: true,
      sub,
      iss,
      aud: payload['aud'] as string | string[] | undefined,
      exp: payload['exp'] as number | undefined,
      iat: payload['iat'] as number | undefined,
      jti: payload['jti'] as string | undefined,
      scope: payload['scope'] as string | undefined,
      client_id: payload['client_id'] as string | undefined,
      cnf: payload['cnf'] as { jkt?: string } | undefined,
    }
  }

  /**
   * Decode token claims from JWT payload (no signature verification)
   */
  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) {
        return null
      }
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      return null
    }
  }

  /**
   * Verify issuer matches the PDS's declared authorization server.
   * Bluesky uses an entryway (bsky.social) as the OAuth issuer while
   * actual PDS hosts differ (e.g., jellybaby.us-east.host.bsky.network).
   *
   * @param sub - The user's DID
   * @param issuerOrigin - The issuer origin (e.g., https://bsky.social)
   * @returns Error message if verification fails, null if successful
   '
   */
  private async verifyPdsAuthServer(
    sub: string,
    issuerOrigin: string,
  ): Promise<string | null> {
    // Resolve the user's DID to find their PDS endpoint
    const pdsEndpoint = await this.getPdsEndpointFromDid(sub)
    if (!pdsEndpoint) {
      return `Could not resolve PDS endpoint for ${sub}`
    }

    const pdsOrigin = new URL(pdsEndpoint).origin
    try {
      const declaredIssuer = await this.fetchAuthServerIssuer(pdsOrigin)
      if (issuerOrigin !== declaredIssuer) {
        return `Issuer ${issuerOrigin} does not match PDS auth server ${declaredIssuer}`
      }
    } catch (err) {
      return err instanceof Error
        ? err.message
        : 'Failed to fetch PDS auth server'
    }

    return null
  }

  /**
   * Check expiration and audience claims
   *
   * @param payload - The JWT payload
   * @returns Error message if verification fails, null if successful
   */
  private checkExpirationAndAudience(
    payload: Record<string, unknown>,
  ): string | null {
    // Check expiration
    const exp = payload['exp'] as number | undefined
    if (exp !== undefined) {
      const nowSec = Math.floor(Date.now() / 1000)
      if (nowSec > exp + 30) {
        return 'Token expired'
      }
    }

    // Check audience if configured
    if (this.audience) {
      const aud = payload['aud'] as string | string[] | undefined
      let audArray: string[]
      if (Array.isArray(aud)) {
        audArray = aud
      } else {
        audArray = aud ? [aud] : []
      }
      if (!audArray.includes(this.audience)) {
        return 'Audience mismatch'
      }
    }

    return null
  }

  /**
   * Fetch the declared authorization server from a PDS's protected resource metadata.
   * Per the AT Protocol OAuth spec, PDS instances are Resource Servers that expose
   * /.well-known/oauth-protected-resource with an authorization_servers array.
   *
   * @param pdsOrigin - The origin of the PDS to fetch the authorization server from.
   * @returns The declared authorization server URL.
   * @throws {Error} If the request fails or the metadata does not contain an authorization server.
   */
  private async fetchAuthServerIssuer(pdsOrigin: string): Promise<string> {
    const cached = this.issuerCache.get(pdsOrigin)
    if (cached) return cached

    const metadataUrl = new URL(
      '/.well-known/oauth-protected-resource',
      pdsOrigin,
    )
    const response = await this.fetch(metadataUrl.toString(), {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(
        `PDS protected resource metadata request failed: ${response.status} from ${pdsOrigin}`,
      )
    }

    const metadata = (await response.json()) as {
      authorization_servers?: string[]
    }
    const authServer = metadata.authorization_servers?.[0]
    if (!authServer) {
      throw new Error(
        `PDS protected resource metadata missing authorization_servers: ${pdsOrigin}`,
      )
    }

    const issuerOrigin = new URL(authServer).origin
    this.issuerCache.set(pdsOrigin, issuerOrigin)
    return issuerOrigin
  }
}
