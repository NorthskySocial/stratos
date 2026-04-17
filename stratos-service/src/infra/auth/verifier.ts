import { InvalidRequestError, } from '@atproto/xrpc-server'
import { type DidDocument, getDidKeyFromMultibase, IdResolver, } from '@atproto/identity'
import * as crypto from '@atproto/crypto'

/**
 * Service auth context (for AppView subscriptions)
 */
interface ServiceAuthResult {
  iss: string // Issuing service DID
  aud: string // Our DID
  lxm?: string // Lexicon method
  exp: number
}

export interface JwtHeader {
  alg: string
  typ?: string
  kid?: string
}

export interface ServiceAuthPayload {
  iss: string
  aud: string
  exp: number
  iat?: number
  lxm?: string
}

/**
 * Parse and perform basic validation for a JWT from an Authorization header
 *
 * @param authHeader - Authorization header value
 * @throws InvalidRequestError if header format or JWT structure is invalid
 * @returns JWT parts and decoded payload
 */
function parseAuthToken(authHeader: string): {
  token: string
  parts: string[]
  header: JwtHeader
  payload: ServiceAuthPayload
} {
  const [bearer, token] = authHeader.split(' ')
  if (bearer?.toLowerCase() !== 'bearer' || !token) {
    throw new InvalidRequestError('Invalid authorization header format')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new InvalidRequestError('Invalid JWT format')
  }

  // Decode JWT header and payload (without verification first)
  try {
    const headerStr = Buffer.from(parts[0], 'base64url').toString()
    const payloadStr = Buffer.from(parts[1], 'base64url').toString()
    const header = JSON.parse(headerStr) as JwtHeader
    const payload = JSON.parse(payloadStr) as ServiceAuthPayload

    if (!header) {
      throw new InvalidRequestError('Missing JWT header')
    }

    return { token, parts, header, payload }
  } catch {
    throw new InvalidRequestError('Invalid JWT encoding')
  }
}

/**
 * Validate JWT claims for service-to-service auth
 *
 * @param payload - JWT payload
 * @param ourDid - Our DID
 * @param expectedLxm - Expected LXM value
 * @throws InvalidRequestError if validation fails
 */
function validateServiceClaims(
  payload: ServiceAuthPayload,
  ourDid: string,
  expectedLxm: string | undefined,
): void {
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
}

/**
 * Verify JWT signature using DID document verification methods
 *
 * @param parts - JWT parts (header, payload, signature)
 * @param iss - Issuer DID
 * @param idResolver - Identity resolver for DID resolution
 * @throws InvalidRequestError if signature verification fails
 */
async function verifyJwtSignature(
  parts: string[],
  iss: string,
  idResolver: IdResolver,
): Promise<void> {
  const didDoc = await resolveIssuerDid(iss, idResolver)
  const verificationMethods = didDoc.verificationMethod ?? []

  const { signingInputBytes, signatureBytes } = prepareVerificationData(parts)

  const verified = await verifyAgainstVerificationMethods(
    verificationMethods,
    signingInputBytes,
    signatureBytes,
  )

  if (!verified) {
    throw new InvalidRequestError('Invalid signature')
  }
}

/**
 * Resolve issuer DID to get the signing key
 * @param iss - Issuer DID
 * @param idResolver - Identity resolver for DID resolution
 * @returns DID document of the issuer
 * @throws InvalidRequestError if DID resolution fails
 */
async function resolveIssuerDid(
  iss: string,
  idResolver: IdResolver,
): Promise<DidDocument> {
  const didDoc = await idResolver.did.resolve(iss)
  if (!didDoc) {
    throw new InvalidRequestError('Could not resolve issuer DID')
  }
  return didDoc
}

/**
 * Prepare signing input and signature bytes from JWT parts
 * @param parts - JWT parts (header, payload, signature)
 * @returns Signing input bytes and signature bytes
 */
function prepareVerificationData(parts: string[]) {
  const signingInput = `${parts[0]}.${parts[1]}`
  const signature = Buffer.from(parts[2], 'base64url')
  const signingInputBytes = new TextEncoder().encode(signingInput)
  const signatureBytes = new Uint8Array(signature)
  return { signingInputBytes, signatureBytes }
}

/**
 * Attempt to verify signature against any of the provided verification methods
 *
 * @param methods - Verification methods to be used
 * @param signingInputBytes - Input data to be signed
 * @param signatureBytes - Signature bytes
 * @returns True if verification succeeds, false otherwise
 * @throws InvalidRequestError if verification fails
 */
async function verifyAgainstVerificationMethods(
  methods: NonNullable<DidDocument['verificationMethod']>,
  signingInputBytes: Uint8Array,
  signatureBytes: Uint8Array,
): Promise<boolean> {
  for (const vm of methods) {
    if (await verifyWithMethod(vm, signingInputBytes, signatureBytes)) {
      return true
    }
  }
  return false
}

/**
 * Verify signature using a single verification method
 *
 * @param vm - Verification method to be used
 * @param signingInputBytes - Input data to be signed
 * @param signatureBytes - Signature bytes
 * @returns True if verification succeeds, false otherwise
 */
async function verifyWithMethod(
  vm: NonNullable<DidDocument['verificationMethod']>[number],
  signingInputBytes: Uint8Array,
  signatureBytes: Uint8Array,
): Promise<boolean> {
  try {
    if (vm.publicKeyMultibase && vm.type) {
      const didKey = getDidKeyFromMultibase({
        type: vm.type,
        publicKeyMultibase: vm.publicKeyMultibase,
      })
      if (didKey) {
        return await crypto.verifySignature(
          didKey,
          signingInputBytes,
          signatureBytes,
        )
      }
    }
  } catch {
    // Try next verification method
  }
  return false
}

/**
 * Verify service-to-service authentication JWT
 *
 * Used for AppView subscriptions and inter-service calls
 *
 * @param authHeader - Authorization header value
 * @param ourDid - Our DID
 * @param expectedLxm - Expected LXM value
 * @param idResolver - Identity resolver for DID resolution
 * @throws InvalidRequestError if JWT validation fails
 * @returns Service authentication context
 */
export async function verifyServiceAuth(
  authHeader: string,
  ourDid: string,
  expectedLxm: string | undefined,
  idResolver: IdResolver,
): Promise<ServiceAuthResult> {
  const { parts, payload } = parseAuthToken(authHeader)

  validateServiceClaims(payload, ourDid, expectedLxm)

  await verifyJwtSignature(parts, payload.iss, idResolver)

  return {
    iss: payload.iss,
    aud: payload.aud,
    lxm: payload.lxm,
    exp: payload.exp,
  }
}
