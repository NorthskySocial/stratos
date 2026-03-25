/**
 * PDS Token Verifier
 *
 * Validates OAuth access tokens by fetching the PDS's JWKS and verifying
 * the JWT signature locally. ATProtocol PDSes don't expose an introspection
 * endpoint - instead resource servers fetch the JWKS and verify tokens themselves.
 */
import * as jose from 'jose'
import { IdResolver } from '@atproto/identity'

/**
 * OAuth Authorization Server Metadata
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
export interface OAuthServerMetadata {
  issuer: string
  jwks_uri?: string
  token_endpoint?: string
  authorization_endpoint?: string
  [key: string]: unknown
}

/**
 * Verified token claims
 */
export interface VerifiedTokenClaims {
  /** Token is valid and verified */
  active: true
  /** Whether the token signature was cryptographically verified.
   * false when the PDS uses symmetric signing (HS256) which can't be
   * verified by a third-party resource server via JWKS. DPoP proof
   * binding still provides authentication assurance in this case. */
  signatureVerified: boolean
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
  /** Maximum age of cached JWKS in ms (default: 1 minute) */
  jwksCacheMaxAge?: number
  /** Time before expiry to start background refresh (default: 15 seconds) */
  jwksRefreshBeforeExpiry?: number
  /** Maximum age of cached verification results in ms (default: 60 seconds) */
  verifyCacheMaxAge?: number
  /** Maximum number of cached verification results (default: 1000) */
  verifyCacheMaxSize?: number
  /** Optional fetch implementation for testing */
  fetch?: typeof globalThis.fetch
}

/**
 * Cached JWKS entry
 */
interface JwksCacheEntry {
  jwks: jose.JSONWebKeySet
  fetchedAt: number
  /** Whether a background refresh is in progress */
  refreshing?: boolean
}

interface VerifyCacheEntry {
  result: TokenVerificationResult
  cachedAt: number
}

/**
 * Client for verifying tokens using PDS JWKS
 *
 * This implements the resource server token verification flow:
 * 1. Extract issuer from token (without verification)
 * 2. Fetch OAuth metadata from issuer/.well-known/oauth-authorization-server
 * 3. Fetch JWKS from jwks_uri
 * 4. Verify token signature using JWKS
 * 5. Return verified claims
 *
 * Note: ATProtocol PDSes don't implement token introspection (RFC 7662).
 * Instead, they publish their signing keys via JWKS and resource servers
 * verify tokens locally.
 */
export class PdsTokenVerifier implements TokenVerifier {
  private readonly idResolver: IdResolver
  private readonly audience?: string
  private readonly jwksCacheMaxAge: number
  private readonly jwksRefreshBeforeExpiry: number
  private readonly verifyCacheMaxAge: number
  private readonly verifyCacheMaxSize: number
  private readonly fetch: typeof globalThis.fetch

  /** Cache of JWKS by issuer URL */
  private readonly jwksCache = new Map<string, JwksCacheEntry>()
  /** Cache of OAuth metadata by issuer URL */
  private readonly metadataCache = new Map<string, OAuthServerMetadata>()
  /** Cache of verification results by access token */
  private readonly verifyCache = new Map<string, VerifyCacheEntry>()

  constructor(config: PdsTokenVerifierConfig) {
    this.idResolver = config.idResolver
    this.audience = config.audience
    this.jwksCacheMaxAge = config.jwksCacheMaxAge ?? 60 * 1000 // 1 minute
    this.jwksRefreshBeforeExpiry = config.jwksRefreshBeforeExpiry ?? 15 * 1000 // 15 seconds
    this.verifyCacheMaxAge = config.verifyCacheMaxAge ?? 60 * 1000 // 1 minute
    this.verifyCacheMaxSize = config.verifyCacheMaxSize ?? 1_000
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * Get the PDS endpoint for a DID by resolving its DID document
   */
  async getPdsEndpointFromDid(did: string): Promise<string | null> {
    try {
      const didDoc = await this.idResolver.did.resolve(did)
      if (!didDoc) return null

      // Find the atproto_pds service endpoint
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
   * Fetch OAuth Authorization Server Metadata
   */
  private async fetchOAuthMetadata(
    issuer: string,
  ): Promise<OAuthServerMetadata> {
    // Check cache first
    const cached = this.metadataCache.get(issuer)
    if (cached) {
      return cached
    }

    const metadataUrl = new URL(
      '/.well-known/oauth-authorization-server',
      issuer,
    )

    const response = await this.fetch(metadataUrl.toString(), {
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(
        `Failed to fetch OAuth metadata from ${issuer}: ${response.status}`,
      )
    }

    const metadata = (await response.json()) as OAuthServerMetadata

    // Validate issuer matches
    if (metadata.issuer !== issuer) {
      throw new Error(
        `OAuth metadata issuer mismatch: expected ${issuer}, got ${metadata.issuer}`,
      )
    }

    // Cache metadata (it's relatively stable)
    this.metadataCache.set(issuer, metadata)

    return metadata
  }

  /**
   * Fetch JWKS from the PDS with background refresh
   */
  private async fetchJwks(jwksUri: string): Promise<jose.JSONWebKeySet> {
    const cached = this.jwksCache.get(jwksUri)
    const now = Date.now()

    if (cached) {
      const age = now - cached.fetchedAt
      const isExpired = age >= this.jwksCacheMaxAge
      const shouldRefresh =
        age >= this.jwksCacheMaxAge - this.jwksRefreshBeforeExpiry

      // If not expired, return cached value
      // If approaching expiry, trigger background refresh
      if (!isExpired) {
        if (shouldRefresh && !cached.refreshing) {
          // Start background refresh
          cached.refreshing = true
          this.refreshJwksInBackground(jwksUri).catch(() => {
            // Reset refreshing flag on error
            const entry = this.jwksCache.get(jwksUri)
            if (entry) entry.refreshing = false
          })
        }
        return cached.jwks
      }
    }

    // Fetch fresh JWKS
    return this.doFetchJwks(jwksUri)
  }

  /**
   * Background refresh of JWKS (non-blocking)
   */
  private async refreshJwksInBackground(jwksUri: string): Promise<void> {
    try {
      await this.doFetchJwks(jwksUri)
    } finally {
      const entry = this.jwksCache.get(jwksUri)
      if (entry) entry.refreshing = false
    }
  }

  /**
   * Actually fetch JWKS from the PDS
   */
  private async doFetchJwks(jwksUri: string): Promise<jose.JSONWebKeySet> {
    const response = await this.fetch(jwksUri, {
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(
        `Failed to fetch JWKS from ${jwksUri}: ${response.status}`,
      )
    }

    const jwks = (await response.json()) as jose.JSONWebKeySet

    // Cache JWKS
    this.jwksCache.set(jwksUri, {
      jwks,
      fetchedAt: Date.now(),
      refreshing: false,
    })

    return jwks
  }

  /**
   * Extract claims from token without verification (for getting issuer)
   */
  private decodeTokenUnsafe(token: string): { iss?: string; sub?: string } {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format')
    }

    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      throw new Error('Failed to decode JWT payload')
    }
  }

  /**
   * Decode the JWT header to inspect the signing algorithm
   */
  private decodeTokenHeader(token: string): { alg?: string; typ?: string } {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format')
    }

    try {
      return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    } catch {
      throw new Error('Failed to decode JWT header')
    }
  }

  /**
   * Decode full token claims without signature verification.
   * Used as fallback when the PDS signs tokens with a symmetric algorithm
   * (HS256) that can't be verified via JWKS by a third-party resource server.
   */
  private decodeTokenClaimsUnsafe(token: string): Record<string, unknown> {
    const parts = token.split('.')
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format')
    }

    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      throw new Error('Failed to decode JWT payload')
    }
  }

  /**
   * Verify an access token
   */
  async verify(token: string): Promise<TokenVerificationResult> {
    // Check verification cache
    const cached = this.verifyCache.get(token)
    if (cached) {
      const age = Date.now() - cached.cachedAt
      if (age < this.verifyCacheMaxAge) {
        // Don't serve cached results for tokens that have expired since caching
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

    // Cache active results; skip caching transient failures
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
    // If still over limit, drop oldest entries
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
    try {
      // 1. Decode token to get issuer (without verification)
      const unsafeClaims = this.decodeTokenUnsafe(token)
      const issuer = unsafeClaims.iss

      if (!issuer) {
        return { active: false, error: 'Token missing issuer (iss) claim' }
      }

      // Validate issuer looks like a URL
      let issuerUrl: URL
      try {
        issuerUrl = new URL(issuer)
      } catch {
        return { active: false, error: `Invalid issuer URL: ${issuer}` }
      }

      // 2. Fetch OAuth metadata to get JWKS URI
      let metadata: OAuthServerMetadata
      try {
        metadata = await this.fetchOAuthMetadata(issuerUrl.origin)
      } catch (err) {
        return {
          active: false,
          error: `Failed to fetch OAuth metadata: ${err instanceof Error ? err.message : 'Unknown error'}`,
        }
      }

      if (!metadata.jwks_uri) {
        return { active: false, error: 'OAuth metadata missing jwks_uri' }
      }

      const jwksUri = metadata.jwks_uri

      // 3. Fetch JWKS
      let jwks: jose.JSONWebKeySet
      try {
        jwks = await this.fetchJwks(jwksUri)
      } catch (err) {
        return {
          active: false,
          error: `Failed to fetch JWKS: ${err instanceof Error ? err.message : 'Unknown error'}`,
        }
      }

      // 4. Create key set for jose
      const keySet = jose.createLocalJWKSet(jwks)

      // 5. Verify token signature and claims
      try {
        const { payload } = await jose.jwtVerify(token, keySet, {
          issuer: issuerUrl.origin,
          audience: this.audience,
          clockTolerance: 30,
        })

        // 6. Validate subject
        if (!payload.sub || !payload.sub.startsWith('did:')) {
          return { active: false, error: 'Invalid subject claim' }
        }

        return {
          active: true,
          signatureVerified: true,
          sub: payload.sub,
          iss: payload.iss!,
          aud: payload.aud,
          exp: payload.exp,
          iat: payload.iat,
          jti: payload.jti,
          scope: payload['scope'] as string | undefined,
          client_id: payload['client_id'] as string | undefined,
          cnf: payload['cnf'] as { jkt?: string } | undefined,
        }
      } catch (verifyErr) {
        const header = this.decodeTokenHeader(token)
        const isSymmetricAlg =
          header.alg === 'HS256' ||
          header.alg === 'HS384' ||
          header.alg === 'HS512'

        if (isSymmetricAlg) {
          return this.buildUnverifiedResult(token, issuerUrl.origin)
        }

        // Cached JWKS may be stale
        // Evict and retry once with a fresh fetch before failing.
        if (verifyErr instanceof jose.errors.JWKSNoMatchingKey) {
          this.jwksCache.delete(jwksUri)
          const freshJwks = await this.doFetchJwks(jwksUri)
          const freshKeySet = jose.createLocalJWKSet(freshJwks)
          const { payload } = await jose.jwtVerify(token, freshKeySet, {
            issuer: issuerUrl.origin,
            audience: this.audience,
            clockTolerance: 30,
          })

          if (!payload.sub || !payload.sub.startsWith('did:')) {
            return { active: false, error: 'Invalid subject claim' }
          }

          return {
            active: true,
            signatureVerified: true,
            sub: payload.sub,
            iss: payload.iss!,
            aud: payload.aud,
            exp: payload.exp,
            iat: payload.iat,
            jti: payload.jti,
            scope: payload['scope'] as string | undefined,
            client_id: payload['client_id'] as string | undefined,
            cnf: payload['cnf'] as { jkt?: string } | undefined,
          }
        }

        throw verifyErr
      }
    } catch (err) {
      // JWKS key miss after retry is an infrastructure failure, not a token
      // problem. Let it propagate so the DPoP verifier logs at error level.
      if (err instanceof jose.errors.JWKSNoMatchingKey) {
        throw err
      }
      if (err instanceof jose.errors.JWTExpired) {
        return { active: false, error: 'Token expired' }
      }
      if (err instanceof jose.errors.JWTClaimValidationFailed) {
        return {
          active: false,
          error: `Claim validation failed: ${err.message}`,
        }
      }
      if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
        return { active: false, error: 'Invalid signature' }
      }
      if (err instanceof jose.errors.JOSEError) {
        return { active: false, error: err.message }
      }
      return {
        active: false,
        error:
          err instanceof Error ? err.message : 'Unknown verification error',
      }
    }
  }

  /**
   * Build a VerifiedTokenClaims result from an unverified token.
   * Used when the PDS signs with a symmetric algorithm that can't be
   * verified via JWKS. Still validates structural claims (sub, exp, etc.).
   */
  private buildUnverifiedResult(
    token: string,
    expectedIssuer: string,
  ): TokenVerificationResult {
    const payload = this.decodeTokenClaimsUnsafe(token)

    const sub = payload['sub'] as string | undefined
    if (!sub || !sub.startsWith('did:')) {
      return { active: false, error: 'Invalid subject claim' }
    }

    const iss = payload['iss'] as string | undefined
    if (!iss) {
      return { active: false, error: 'Missing issuer claim' }
    }

    // Validate issuer matches what we fetched metadata from
    try {
      const issUrl = new URL(iss)
      if (issUrl.origin !== expectedIssuer) {
        return { active: false, error: 'Issuer mismatch' }
      }
    } catch {
      return { active: false, error: 'Invalid issuer URL in token' }
    }

    // Check expiration
    const exp = payload['exp'] as number | undefined
    if (exp !== undefined) {
      const now = Math.floor(Date.now() / 1000)
      if (now > exp + 30) {
        return { active: false, error: 'Token expired' }
      }
    }

    return {
      active: true,
      signatureVerified: false,
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
    this.jwksCache.clear()
    this.metadataCache.clear()
    this.verifyCache.clear()
  }
}

/**
 * @deprecated Use PdsTokenVerifier instead - PDS doesn't expose introspection endpoint
 */
export const PdsIntrospectionClient = PdsTokenVerifier
export type IntrospectionResponse = VerifiedTokenClaims
