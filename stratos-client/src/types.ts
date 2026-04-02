export type { FetchHandler, FetchHandlerObject } from '@atcute/client'

/**
 * stratos enrollment record as stored on the user's PDS.
 * matches the `zone.stratos.actor.enrollment` lexicon shape.
 */
export interface StratosEnrollment {
  service: string
  boundaries: Array<{ value: string }>
  signingKey: string
  attestation: ServiceAttestation
  createdAt: string
  rkey: string
}

/**
 * service attestation vouching for the user's enrollment, boundaries, and signing key.
 * the signed payload is DAG-CBOR encoded {boundaries, did, signingKey} with sorted keys.
 */
export interface ServiceAttestation {
  sig: Uint8Array
  signingKey: string
}

/**
 * verification level indicating what was cryptographically checked.
 * - 'user-signature': full signature verification against the user's per-actor signing key + DID match
 * - 'service-signature': full signature verification against the service's signing key + DID match
 * - 'cid-integrity': Cid integrity and MST path validation only (no signature check)
 */
export type VerificationLevel =
  | 'user-signature'
  | 'service-signature'
  | 'cid-integrity'

/**
 * result of record verification via inclusion proof.
 */
export interface VerifiedRecord {
  cid: string
  record: unknown
  level: VerificationLevel
}

/**
 * options for fetchAndVerifyRecord.
 */
export interface FetchAndVerifyOptions {
  /**
   * the user's per-actor public signing key from @atcute/crypto.
   * when provided, verifies the commit was signed by the user's key.
   * callers should cache the result of resolveUserSigningKey.
   */
  userSigningKey?: import('@atcute/crypto').PublicKey
  /**
   * the service's public signing key from @atcute/crypto.
   * used as fallback when userSigningKey is not provided.
   * callers should cache the result of resolveServiceSigningKey.
   */
  serviceSigningKey?: import('@atcute/crypto').PublicKey
  /**
   * optional fetch function for the CAR request.
   * defaults to global fetch.
   */
  fetchFn?: typeof fetch
}

/**
 * options for resolveServiceSigningKey.
 */
export interface ResolveSigningKeyOptions {
  /**
   * optional fetch function for the DID document request.
   * defaults to global fetch.
   */
  fetchFn?: typeof fetch
}

/**
 * OAuth scope identifiers used by Stratos.
 */
export interface StratosScopes {
  enrollment: string
  post: string
}
