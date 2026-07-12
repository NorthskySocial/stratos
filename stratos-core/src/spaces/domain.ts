/**
 * Pure, dependency-light library for parsing, serializing, validating, and
 * mapping permissioned space/record URIs and Stratos boundaries.
 *
 * Space and record URIs reuse the standard `at://` scheme with a fixed literal
 * `space` marker segment sitting where a collection NSID appears in a public
 * atproto URI. This module is the single source of truth for that addressing:
 * no other code should parse these URIs.
 *
 * URI grammar (byte-exact, no normalization):
 *   - space URI:  `at://{spaceDid}/space/{spaceType}/{skey}`
 *   - record URI: `at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
 *
 * The marker disambiguates these from public `at://` URIs by construction: a
 * public collection segment is an NSID (always at least two dots) and never the
 * bare word `space`, so a public-shaped URI is always reported as
 * `invalid-space-marker` and can never be mistaken for a space URI. A URI that
 * does carry `space` in the marker position but has the wrong segment count
 * reports `invalid-component-count`.
 *
 * Canonical form is strict string equality: two URIs address the same resource
 * iff their strings are byte-equal. There is no case folding, no relative form,
 * and no DID compression.
 *
 * Error convention: the rest of `stratos-core` signals failures by throwing
 * typed `StratosError` subclasses, but parsing untrusted URIs is a routine,
 * expected-to-fail operation that must never throw. This module therefore
 * returns a discriminated `SpacesResult<T> = { ok: true, value } | { ok: false,
 * error }` instead. Boolean predicates (e.g. {@link isValidSkey}) return plain
 * booleans.
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

/** The URI scheme shared with public atproto addresses. */
export const AT_SCHEME = 'at://'

/**
 * The literal marker segment that identifies a space/record URI. It sits in the
 * position a collection NSID occupies in a public `at://` URI and, unlike an
 * NSID, contains no dots.
 */
export const SPACE_SEGMENT = 'space'

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
  // Every UTF-16 code unit encodes to >=1 UTF-8 byte and <=3 (a surrogate pair
  // is 2 units -> 4 bytes), so utf8ByteLength(s) lies in [s.length, 3*s.length].
  if (s.length === 0 || s.length > SKEY_MAX_BYTES) {
    return false
  }
  if (s.length * 3 > SKEY_MAX_BYTES && utf8ByteLength(s) > SKEY_MAX_BYTES) {
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
 * Splits the authority-and-path portion (everything after `at://`) of a URI
 * into its raw `/`-separated components, or reports a scheme error. Empty
 * components are preserved so that callers can reject them explicitly.
 */
function splitAtUri(s: string): SpacesResult<string[]> {
  if (!s.startsWith(AT_SCHEME)) {
    return err('invalid-scheme', `URI must start with "${AT_SCHEME}"`)
  }
  const rest = s.slice(AT_SCHEME.length)
  return ok(rest.split('/'))
}

/**
 * Splits an `at://` URI, requires the literal `space` marker in the segment
 * after the authority, and requires an exact component count. The marker is
 * checked before the count so a public-shaped URI without it is reported as
 * `invalid-space-marker` rather than a count mismatch. `label` ("space URI" /
 * "record URI") and `expectedCount` keep the error messages per-kind.
 */
function parseAtUriHeader(
  s: string,
  expectedCount: number,
  label: string,
): SpacesResult<string[]> {
  const split = splitAtUri(s)
  if (!split.ok) return split
  const parts = split.value
  if (parts[1] !== SPACE_SEGMENT) {
    return err(
      'invalid-space-marker',
      `${label} must have "${SPACE_SEGMENT}" as the segment after the authority`,
    )
  }
  if (parts.length !== expectedCount) {
    return err(
      'invalid-component-count',
      `${label} must have ${expectedCount} components, got ${parts.length}`,
    )
  }
  return ok(parts)
}

/** Validates the space-addressing fields shared by space and record URIs. */
function validateSpaceParts(parts: SpaceUri): SpacesResult<SpaceUri> {
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
  return ok(parts)
}

/** Validates the record-only fields a record URI adds to the space fields. */
function validateRecordExtras(parts: {
  authorDid: string
  collection: string
  rkey: string
}): SpacesResult<void> {
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
  return ok(undefined)
}

/**
 * Parses a space URI: `at://{spaceDid}/space/{spaceType}/{skey}` (4 components,
 * with `space` as the segment following the authority).
 */
export function parseSpaceUri(s: string): SpacesResult<SpaceUri> {
  const header = parseAtUriHeader(s, 4, 'space URI')
  if (!header.ok) return header
  const [spaceDid, , spaceType, skey] = header.value
  return validateSpaceParts({ spaceDid, spaceType, skey })
}

/**
 * Parses a record URI:
 * `at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
 * (7 components, with `space` as the segment following the authority).
 */
export function parseRecordUri(s: string): SpacesResult<RecordUri> {
  const header = parseAtUriHeader(s, 7, 'record URI')
  if (!header.ok) return header
  const [spaceDid, , spaceType, skey, authorDid, collection, rkey] =
    header.value
  const space = validateSpaceParts({ spaceDid, spaceType, skey })
  if (!space.ok) return space
  const extras = validateRecordExtras({ authorDid, collection, rkey })
  if (!extras.ok) return extras
  return ok({ spaceDid, spaceType, skey, authorDid, collection, rkey })
}

/**
 * Serializes space URI parts into `at://{spaceDid}/space/{spaceType}/{skey}`.
 * Byte-exact inverse of {@link parseSpaceUri}: `parse(format(x)) === x` for
 * valid parts, and `format(parse(s)) === s` for valid URIs.
 *
 * Validates the parts and returns a result; invalid parts never throw.
 */
export function formatSpaceUri(parts: SpaceUri): SpacesResult<string> {
  const valid = validateSpaceParts(parts)
  if (!valid.ok) return valid
  return ok(
    `${AT_SCHEME}${parts.spaceDid}/${SPACE_SEGMENT}/${parts.spaceType}/${parts.skey}`,
  )
}

/**
 * Serializes record URI parts into
 * `at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
 * Byte-exact inverse of {@link parseRecordUri}.
 *
 * Validates the parts and returns a result; invalid parts never throw.
 */
export function formatRecordUri(parts: RecordUri): SpacesResult<string> {
  const space = validateSpaceParts(parts)
  if (!space.ok) return space
  const extras = validateRecordExtras(parts)
  if (!extras.ok) return extras
  return ok(
    `${AT_SCHEME}${parts.spaceDid}/${SPACE_SEGMENT}/${parts.spaceType}/${parts.skey}/${parts.authorDid}/${parts.collection}/${parts.rkey}`,
  )
}

/**
 * Maps a Stratos boundary to a space URI:
 *   - boundary format: `{serviceDid}/{domainName}`
 *   - `serviceDid` -> `spaceDid`
 *   - `domainName` -> `skey`
 *   - `spaceType`  -> caller-supplied NSID parameter
 *
 * The boundary is split on the first `/`. Because a syntactically valid DID
 * cannot contain `/`, this split is unambiguous. The URI is built via
 * {@link formatSpaceUri} so the two can never drift.
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
  const spaceDid = boundary.slice(0, slash)
  const skey = boundary.slice(slash + 1)
  return formatSpaceUri({ spaceDid, spaceType, skey })
}

/**
 * Inverse of {@link boundaryToSpaceUri}: maps a space URI back to a Stratos
 * boundary `{serviceDid}/{domainName}`.
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
