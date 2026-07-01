/**
 * Parsed components of a three-component `ats://` space URI:
 * `ats://{spaceDid}/{spaceType}/{skey}`.
 */
export interface SpaceUri {
  /** Space authority DID (the service DID). */
  spaceDid: string
  /** Space type NSID. */
  spaceType: string
  /** Space key (rkey syntax, 1-512 UTF-8 bytes). */
  skey: string
}

/**
 * Parsed components of a six-component `ats://` record URI:
 * `ats://{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
 */
export interface RecordUri {
  /** Space authority DID (the service DID). */
  spaceDid: string
  /** Space type NSID. */
  spaceType: string
  /** Space key (rkey syntax, 1-512 UTF-8 bytes). */
  skey: string
  /** Author DID (the user's real DID, e.g. `did:plc:...`). */
  authorDid: string
  /** Record collection NSID. */
  collection: string
  /** Record key. */
  rkey: string
}

/**
 * Kinds of failure that can occur while parsing/validating an `ats://` URI or a
 * Stratos boundary. Used as the discriminant of {@link SpacesError}.
 */
export type SpacesErrorCode =
  | 'invalid-scheme'
  | 'invalid-component-count'
  | 'invalid-space-did'
  | 'invalid-space-type'
  | 'invalid-skey'
  | 'invalid-author-did'
  | 'invalid-collection'
  | 'invalid-rkey'
  | 'invalid-boundary'
  | 'service-did-mismatch'

/**
 * A structured, non-thrown validation/parsing failure.
 */
export interface SpacesError {
  code: SpacesErrorCode
  message: string
}

/**
 * A discriminated result: either `{ ok: true, value }` on success or
 * `{ ok: false, error }` on failure. See the module docstring in `domain.ts`
 * for why this convention is used.
 */
export type SpacesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SpacesError }
