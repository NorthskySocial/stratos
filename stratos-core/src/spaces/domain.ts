/**
 * Pure, dependency-light library for parsing, serializing, validating, and
 * mapping permissioned space/record URIs and Stratos boundaries.
 *
 * Space and record URIs use their own `at:space/` prefix, distinct from the
 * `at://` form of public and custody record URIs. This module is the single
 * source of truth for that addressing: no other code should parse these URIs,
 * and a space URI must never be handed to a public-only parser such as
 * `AtUri`.
 *
 * URI grammar (byte-exact, no normalization):
 *   - space URI:  `at:space/{spaceDid}/{spaceType}/{skey}`
 *   - record URI: `at:space/{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
 *
 * After the exact prefix `at:space/` the text is split on `/` into exactly
 * three (space) or six (record) parts, each validated on its own. A string
 * that does not start with `at:` is reported as `invalid-scheme`; one that
 * starts with `at:` but not with `at:space/` is reported as
 * `invalid-space-marker`; the wrong number of parts is reported as
 * `invalid-component-count`. No other spelling is recognised.
 *
 * Canonical form is strict string equality: two URIs address the same resource
 * iff their strings are byte-equal. There is no case folding, no relative form,
 * no percent-decoding, and no DID compression.
 *
 * Error convention: the rest of `stratos-core` signals failures by throwing
 * typed `StratosError` subclasses, but parsing untrusted URIs is a routine,
 * expected-to-fail operation that must never throw. This module therefore
 * returns a discriminated `SpacesResult<T> = { ok: true, value } | { ok: false,
 * error }` instead. Boolean predicates (e.g. {@link isValidSkey}) return plain
 * booleans.
 *
 * DID validation is syntactic only (`did:` + method + non-empty
 * method-specific id), delegated to `@atproto/syntax`'s `isValidDid`; inside a
 * space or record URI every `%` must additionally be followed by two hex
 * digits. NSID and record-key validation are likewise delegated to
 * `@atproto/syntax`. The skey byte-length rule is enforced independently by
 * {@link utf8ByteLength} because the atproto record-key check counts UTF-16
 * code units, whereas the skey spec requires 1-512 UTF-8 bytes.
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

/** The exact prefix every space and record URI starts with. */
export const SPACE_URI_PREFIX = 'at:space/'

const URI_SCHEME_PREFIX = 'at:'
const SPACE_PART_COUNT = 3
const RECORD_PART_COUNT = 6
const UNESCAPED_PERCENT = /%(?![0-9A-Fa-f]{2})/

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
 * Splits a space or record URI into its `/`-separated parts after the
 * `at:space/` prefix and requires an exact part count. Empty parts are kept so
 * that the part validators reject them. `label` ("space URI" / "record URI")
 * keeps the error messages per-kind.
 */
function splitSpaceUri(
  s: string,
  expectedCount: number,
  label: string,
): SpacesResult<string[]> {
  if (!s.startsWith(URI_SCHEME_PREFIX)) {
    return err(
      'invalid-scheme',
      `${label} must start with "${SPACE_URI_PREFIX}"`,
    )
  }
  if (!s.startsWith(SPACE_URI_PREFIX)) {
    return err(
      'invalid-space-marker',
      `${label} must start with "${SPACE_URI_PREFIX}"`,
    )
  }
  const parts = s.slice(SPACE_URI_PREFIX.length).split('/')
  if (parts.length !== expectedCount) {
    return err(
      'invalid-component-count',
      `${label} must have ${expectedCount} components after "${SPACE_URI_PREFIX}", got ${parts.length}`,
    )
  }
  return ok(parts)
}

/** A DID as it may appear in a space or record URI. */
function isUriDid(s: string): boolean {
  return isSyntacticDid(s) && !UNESCAPED_PERCENT.test(s)
}

/** Validates the space-addressing fields shared by space and record URIs. */
function validateSpaceParts(parts: SpaceUri): SpacesResult<SpaceUri> {
  if (!isUriDid(parts.spaceDid)) {
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
  if (!isUriDid(parts.authorDid)) {
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
 * Parses a space URI: `at:space/{spaceDid}/{spaceType}/{skey}` (3 components
 * after the prefix).
 */
export function parseSpaceUri(s: string): SpacesResult<SpaceUri> {
  const split = splitSpaceUri(s, SPACE_PART_COUNT, 'space URI')
  if (!split.ok) return split
  const [spaceDid, spaceType, skey] = split.value
  return validateSpaceParts({ spaceDid, spaceType, skey })
}

/**
 * Parses a record URI:
 * `at:space/{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
 * (6 components after the prefix).
 */
export function parseRecordUri(s: string): SpacesResult<RecordUri> {
  const split = splitSpaceUri(s, RECORD_PART_COUNT, 'record URI')
  if (!split.ok) return split
  const [spaceDid, spaceType, skey, authorDid, collection, rkey] = split.value
  const space = validateSpaceParts({ spaceDid, spaceType, skey })
  if (!space.ok) return space
  const extras = validateRecordExtras({ authorDid, collection, rkey })
  if (!extras.ok) return extras
  return ok({ spaceDid, spaceType, skey, authorDid, collection, rkey })
}

/**
 * Serializes space URI parts into `at:space/{spaceDid}/{spaceType}/{skey}`.
 * Byte-exact inverse of {@link parseSpaceUri}: `parse(format(x)) === x` for
 * valid parts, and `format(parse(s)) === s` for valid URIs.
 *
 * Validates the parts and returns a result; invalid parts never throw.
 */
export function formatSpaceUri(parts: SpaceUri): SpacesResult<string> {
  const valid = validateSpaceParts(parts)
  if (!valid.ok) return valid
  return ok(
    `${SPACE_URI_PREFIX}${parts.spaceDid}/${parts.spaceType}/${parts.skey}`,
  )
}

/**
 * Serializes record URI parts into
 * `at:space/{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
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
    `${SPACE_URI_PREFIX}${parts.spaceDid}/${parts.spaceType}/${parts.skey}/${parts.authorDid}/${parts.collection}/${parts.rkey}`,
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
