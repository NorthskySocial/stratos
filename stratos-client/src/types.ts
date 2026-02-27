export type { FetchHandler, FetchHandlerObject } from '@atcute/client'

/**
 * stratos enrollment record as stored on the user's PDS.
 * matches the `app.stratos.actor.enrollment` lexicon shape.
 */
export interface StratosEnrollment {
  service: string
  boundaries: Array<{ value: string }>
  createdAt: string
}

/**
 * verification level indicating what was cryptographically checked.
 * - 'service-signature': full signature verification against the service's signing key + DID match
 * - 'cid-integrity': CID integrity and MST path validation only (no signature check)
 */
export type VerificationLevel = 'service-signature' | 'cid-integrity'

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
   * the service's public signing key from @atcute/crypto.
   * when provided, full signature verification is performed.
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
