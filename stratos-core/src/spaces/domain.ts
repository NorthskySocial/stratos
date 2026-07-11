/**
 * Pure, dependency-light library for parsing, serializing, validating, and
 * mapping `ats://` space/record URIs and Stratos boundaries.
 *
 * This is the single source of truth for `ats://` addressing: no other code
 * should parse `ats://` strings.
 *
 * URI grammar (byte-exact, no normalization):
 *   - record URI: `ats://{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
 *   - space URI:  `ats://{spaceDid}/{spaceType}/{skey}`
 *
 * Canonical form is strict string equality: two URIs address the same resource
 * iff their strings are byte-equal. There is no case folding, no relative form,
 * and no DID compression.
 *
 * Error convention: the `stratos-core` package has no pre-existing discriminated
 * result / neverthrow precedent (the codebase otherwise signals failures by
 * throwing typed `StratosError` subclasses). Because this work package requires
 * that invalid input never throws, this module returns a discriminated
 * `SpacesResult<T> = { ok: true, value } | { ok: false, error }` instead.
 * Boolean predicates (e.g. {@link isValidSkey}) return plain booleans.
 *
 * DID validation is syntactic only (`did:` + method + non-empty
 * method-specific id), delegated to `@atproto/syntax`'s `isValidDid`. NSID and
 * record-key validation are likewise delegated to `@atproto/syntax`. The skey
 * byte-length rule is enforced independently by {@link utf8ByteLength} because
 * the atproto record-key check counts UTF-16 code units, whereas the skey spec
 * requires 1-512 UTF-8 bytes.
 */
import { isValidDid, isValidNsid, isValidRecordKey } from '@atproto/syntax'

import type {
  RecordUri,
  SpaceUri,
  SpacesError,
  SpacesErrorCode,
  SpacesResult,
} from './types.js'

/** The URI scheme for Stratos space and record addresses. */
export const ATS_SCHEME = 'ats://'

/** Minimum skey length in UTF-8 bytes (inclusive). */
export const SKEY_MIN_BYTES = 1
/** Maximum skey length in UTF-8 bytes (inclusive). */
export const SKEY_MAX_BYTES = 512

function err(
  code: SpacesErrorCode,
  message: string,
): {
  ok: false
  error: SpacesError
} {
  return { ok: false, error: { code, message } }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/**
 * Shared encoder — reused across calls to avoid allocating a `TextEncoder` on
 * every skey validation (this runs on the record write path). `TextEncoder` is
 * used rather than `Buffer` so the module stays browser-safe for `stratos-client`.
 */
const UTF8_ENCODER = new TextEncoder()

/**
 * Returns the UTF-8 byte length of a string. Independent of code-unit /
 * code-point counting so the skey byte-length rule can be enforced exactly.
 */
export function utf8ByteLength(s: string): number {
  return UTF8_ENCODER.encode(s).length
}

/**
 * Validates a space key (`skey`). An skey uses record-key syntax
 * (ASCII `A-Z a-z 0-9 . _ : ~ -`; must not be `.` or `..`) and must be
 * 1-512 UTF-8 bytes.
 *
 * Because the record-key alphabet is ASCII-only, any multi-byte character is
 * rejected by the character rule; the byte-length rule is additionally and
 * independently enforced via {@link utf8ByteLength}.
 */
export function isValidSkey(s: string): boolean {
  const bytes = utf8ByteLength(s)
  if (bytes < SKEY_MIN_BYTES || bytes > SKEY_MAX_BYTES) {
    return false
  }
  return isValidRecordKey(s)
}

/**
 * Validates a DID syntactically: `did:` prefix, a lower-case method, and a
 * non-empty method-specific identifier. No network resolution.
 */
export function isSyntacticDid(s: string): boolean {
  return isValidDid(s)
}

/**
 * Validates an NSID (namespaced identifier).
 */
export function isValidNsidStr(s: string): boolean {
  return isValidNsid(s)
}

/**
 * Validates a record key (rkey) using atproto record-key syntax.
 */
export function isValidRkey(s: string): boolean {
  return isValidRecordKey(s)
}

/**
 * Splits the path portion (everything after `ats://`) of a URI into its raw
 * components, or reports a scheme error. Empty components are preserved so that
 * callers can reject them explicitly.
 */
function splitAtsUri(s: string): SpacesResult<string[]> {
  if (!s.startsWith(ATS_SCHEME)) {
    return err('invalid-scheme', `URI must start with "${ATS_SCHEME}"`)
  }
  const rest = s.slice(ATS_SCHEME.length)
  return ok(rest.split('/'))
}

/**
 * Parses a three-component space URI: `ats://{spaceDid}/{spaceType}/{skey}`.
 */
export function parseSpaceUri(s: string): SpacesResult<SpaceUri> {
  const split = splitAtsUri(s)
  if (!split.ok) return split
  const parts = split.value
  if (parts.length !== 3) {
    return err(
      'invalid-component-count',
      `space URI must have 3 components, got ${parts.length}`,
    )
  }
  const [spaceDid, spaceType, skey] = parts
  if (!isSyntacticDid(spaceDid)) {
    return err('invalid-space-did', `invalid space DID: "${spaceDid}"`)
  }
  if (!isValidNsidStr(spaceType)) {
    return err('invalid-space-type', `invalid space type NSID: "${spaceType}"`)
  }
  if (!isValidSkey(skey)) {
    return err('invalid-skey', `invalid skey: "${skey}"`)
  }
  return ok({ spaceDid, spaceType, skey })
}

/**
 * Parses a six-component record URI:
 * `ats://{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
 */
export function parseRecordUri(s: string): SpacesResult<RecordUri> {
  const split = splitAtsUri(s)
  if (!split.ok) return split
  const parts = split.value
  if (parts.length !== 6) {
    return err(
      'invalid-component-count',
      `record URI must have 6 components, got ${parts.length}`,
    )
  }
  const [spaceDid, spaceType, skey, authorDid, collection, rkey] = parts
  if (!isSyntacticDid(spaceDid)) {
    return err('invalid-space-did', `invalid space DID: "${spaceDid}"`)
  }
  if (!isValidNsidStr(spaceType)) {
    return err('invalid-space-type', `invalid space type NSID: "${spaceType}"`)
  }
  if (!isValidSkey(skey)) {
    return err('invalid-skey', `invalid skey: "${skey}"`)
  }
  if (!isSyntacticDid(authorDid)) {
    return err('invalid-author-did', `invalid author DID: "${authorDid}"`)
  }
  if (!isValidNsidStr(collection)) {
    return err('invalid-collection', `invalid collection NSID: "${collection}"`)
  }
  if (!isValidRkey(rkey)) {
    return err('invalid-rkey', `invalid rkey: "${rkey}"`)
  }
  return ok({ spaceDid, spaceType, skey, authorDid, collection, rkey })
}

/**
 * Serializes space URI parts into `ats://{spaceDid}/{spaceType}/{skey}`.
 * Byte-exact inverse of {@link parseSpaceUri}: `parse(format(x)) === x` for
 * valid parts, and `format(parse(s)) === s` for valid URIs.
 *
 * Validates the parts and returns a result; invalid parts never throw.
 */
export function formatSpaceUri(parts: SpaceUri): SpacesResult<string> {
  if (!isSyntacticDid(parts.spaceDid)) {
    return err('invalid-space-did', `invalid space DID: "${parts.spaceDid}"`)
  }
  if (!isValidNsidStr(parts.spaceType)) {
    return err(
      'invalid-space-type',
      `invalid space type NSID: "${parts.spaceType}"`,
    )
  }
  if (!isValidSkey(parts.skey)) {
    return err('invalid-skey', `invalid skey: "${parts.skey}"`)
  }
  return ok(`${ATS_SCHEME}${parts.spaceDid}/${parts.spaceType}/${parts.skey}`)
}

/**
 * Serializes record URI parts into
 * `ats://{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
 * Byte-exact inverse of {@link parseRecordUri}.
 *
 * Validates the parts and returns a result; invalid parts never throw.
 */
export function formatRecordUri(parts: RecordUri): SpacesResult<string> {
  if (!isSyntacticDid(parts.spaceDid)) {
    return err('invalid-space-did', `invalid space DID: "${parts.spaceDid}"`)
  }
  if (!isValidNsidStr(parts.spaceType)) {
    return err(
      'invalid-space-type',
      `invalid space type NSID: "${parts.spaceType}"`,
    )
  }
  if (!isValidSkey(parts.skey)) {
    return err('invalid-skey', `invalid skey: "${parts.skey}"`)
  }
  if (!isSyntacticDid(parts.authorDid)) {
    return err('invalid-author-did', `invalid author DID: "${parts.authorDid}"`)
  }
  if (!isValidNsidStr(parts.collection)) {
    return err(
      'invalid-collection',
      `invalid collection NSID: "${parts.collection}"`,
    )
  }
  if (!isValidRkey(parts.rkey)) {
    return err('invalid-rkey', `invalid rkey: "${parts.rkey}"`)
  }
  return ok(
    `${ATS_SCHEME}${parts.spaceDid}/${parts.spaceType}/${parts.skey}/${parts.authorDid}/${parts.collection}/${parts.rkey}`,
  )
}

/**
 * Maps a Stratos boundary to a three-component space URI (mapping scheme A):
 *   - boundary format: `{serviceDid}/{domainName}`
 *   - `serviceDid` -> `spaceDid`
 *   - `domainName` -> `skey` (validated as an skey)
 *   - `spaceType`  -> caller-supplied NSID parameter
 *
 * The boundary is split on the first `/`. Because a syntactically valid DID
 * cannot contain `/`, this split is unambiguous.
 */
export function boundaryToSpaceUri(
  boundary: string,
  spaceType: string,
): SpacesResult<string> {
  const slash = boundary.indexOf('/')
  if (slash === -1) {
    return err(
      'invalid-boundary',
      `boundary must be "{serviceDid}/{domainName}", got "${boundary}"`,
    )
  }
  const serviceDid = boundary.slice(0, slash)
  const domainName = boundary.slice(slash + 1)
  if (!isSyntacticDid(serviceDid)) {
    return err(
      'invalid-space-did',
      `invalid boundary service DID: "${serviceDid}"`,
    )
  }
  if (!isValidNsidStr(spaceType)) {
    return err('invalid-space-type', `invalid space type NSID: "${spaceType}"`)
  }
  if (!isValidSkey(domainName)) {
    return err(
      'invalid-skey',
      `boundary domainName is not a valid skey: "${domainName}"`,
    )
  }
  return ok(`${ATS_SCHEME}${serviceDid}/${spaceType}/${domainName}`)
}

/**
 * Inverse of {@link boundaryToSpaceUri}: maps a three-component space URI back
 * to a Stratos boundary `{serviceDid}/{domainName}`.
 *
 * Errors if the URI's `spaceDid` does not byte-equal `expectedServiceDid`.
 */
export function spaceUriToBoundary(
  uri: string,
  expectedServiceDid: string,
): SpacesResult<string> {
  const parsed = parseSpaceUri(uri)
  if (!parsed.ok) return parsed
  if (parsed.value.spaceDid !== expectedServiceDid) {
    return err(
      'service-did-mismatch',
      `space DID "${parsed.value.spaceDid}" does not match expected service DID "${expectedServiceDid}"`,
    )
  }
  return ok(`${parsed.value.spaceDid}/${parsed.value.skey}`)
}
