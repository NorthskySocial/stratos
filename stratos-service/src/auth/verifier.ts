import {
  MethodAuthVerifier,
  InvalidRequestError,
  type MethodAuthContext,
} from '@atproto/xrpc-server'
import { IdResolver, getDidKeyFromMultibase } from '@atproto/identity'
import * as crypto from '@atproto/crypto'
import {
  type EnrollmentConfig,
  assertEnrollment,
  EnrollmentDeniedError,
} from './enrollment.js'

export type XrpcAuthVerifier = MethodAuthVerifier

/**
 * Access token claims from OAuth
 */
export interface AccessTokenClaims {
  sub: string // User DID
  aud?: string // Audience (Stratos service DID)
  scope?: string
  iat?: number
  exp?: number
}

/**
 * Authenticated user context
 */
export interface AuthContext {
  did: string
  isServiceAuth: boolean
  serviceDid?: string
}

/**
 * Service auth context (for AppView subscriptions)
 */
export interface ServiceAuthContext {
  iss: string // Issuing service DID
  aud: string // Our DID
  lxm?: string // Lexicon method
  exp: number
}

/**
 * Auth configuration
 */
export interface AuthConfig {
  serviceDid: string
  enrollmentConfig: EnrollmentConfig
  adminPassword?: string
}

/**
 * Create an auth verifier for user requests
 */
export function createAuthVerifier(
  config: AuthConfig,
  idResolver: IdResolver,
  validateAccessToken: (token: string) => Promise<AccessTokenClaims>,
): XrpcAuthVerifier {
  return async (ctx: MethodAuthContext) => {
    const authHeader = ctx.req.headers.authorization

    if (!authHeader) {
      throw new InvalidRequestError('Authorization header required')
    }

    const [bearer, token] = authHeader.split(' ')
    if (bearer?.toLowerCase() !== 'bearer' || !token) {
      throw new InvalidRequestError('Invalid authorization header format')
    }

    // Check if this is admin auth
    if (config.adminPassword && token === config.adminPassword) {
      return {
        credentials: {
          type: 'admin',
          did: config.serviceDid,
        },
      }
    }

    // Validate OAuth access token
    const claims = await validateAccessToken(token)

    // Check enrollment
    try {
      await assertEnrollment(config.enrollmentConfig, claims.sub, idResolver)
    } catch (err) {
      if (err instanceof EnrollmentDeniedError) {
        throw new InvalidRequestError(err.message, 'NotEnrolled')
      }
      throw err
    }

    return {
      credentials: {
        type: 'user',
        did: claims.sub,
      },
    }
  }
}

/**
 * Verify service-to-service authentication JWT
 *
 * Used for AppView subscriptions and inter-service calls
 */
export async function verifyServiceAuth(
  authHeader: string,
  ourDid: string,
  expectedLxm: string | undefined,
  idResolver: IdResolver,
): Promise<ServiceAuthContext> {
  const [bearer, token] = authHeader.split(' ')
  if (bearer?.toLowerCase() !== 'bearer' || !token) {
    throw new InvalidRequestError('Invalid authorization header format')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new InvalidRequestError('Invalid JWT format')
  }

  // Decode JWT header and payload (without verification first)
  const headerStr = Buffer.from(parts[0], 'base64url').toString()
  const payloadStr = Buffer.from(parts[1], 'base64url').toString()
  const header = JSON.parse(headerStr)
  const payload = JSON.parse(payloadStr)

  // Validate header
  if (!header) {
    throw new InvalidRequestError('Missing JWT header')
  }

  // Validate claims
  if (!payload.iss) {
    throw new InvalidRequestError('Missing iss claim')
  }
  if (!payload.aud) {
    throw new InvalidRequestError('Missing aud claim')
  }
  if (payload.aud !== ourDid) {
    throw new InvalidRequestError('Invalid aud claim')
  }
  if (!payload.exp || Date.now() / 1000 > payload.exp) {
    throw new InvalidRequestError('Token expired')
  }
  if (expectedLxm && payload.lxm && payload.lxm !== expectedLxm) {
    throw new InvalidRequestError('Invalid lxm claim')
  }

  // Resolve issuer DID to get signing key
  const didDoc = await idResolver.did.resolve(payload.iss)
  if (!didDoc) {
    throw new InvalidRequestError('Could not resolve issuer DID')
  }

  // Get verification methods from DID document
  const verificationMethods = didDoc.verificationMethod ?? []
  let verified = false

  for (const vm of verificationMethods) {
    try {
      // Get public key from verification method
      // let publicKeyBytes: Uint8Array | null = null

      if (vm.publicKeyMultibase && vm.type) {
        const didKey = getDidKeyFromMultibase({
          type: vm.type,
          publicKeyMultibase: vm.publicKeyMultibase,
        })
        if (didKey) {
          // Verify signature using did:key format
          const signingInput = `${parts[0]}.${parts[1]}`
          const signature = Buffer.from(parts[2], 'base64url')
          try {
            verified = await crypto.verifySignature(
              didKey,
              new TextEncoder().encode(signingInput),
              new Uint8Array(signature),
            )
            if (verified) break
          } catch {
            // Try next verification method
          }
        }
      }

      // Verification already handled above via didKey
    } catch {
      // Try next verification method
    }
  }

  if (!verified) {
    throw new InvalidRequestError('Invalid signature')
  }

  return {
    iss: payload.iss,
    aud: payload.aud,
    lxm: payload.lxm,
    exp: payload.exp,
  }
}

/**
 * Create a simple auth verifier that allows any user (for testing)
 */
export function createOpenAuthVerifier(): XrpcAuthVerifier {
  return async () => {
    return {
      credentials: {
        type: 'none',
      },
    }
  }
}
