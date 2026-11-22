/**
 * Space and record URIs, self-contained so the browser client needs no core
 * import. The grammar and the identifier rules mirror stratos-core's `spaces`
 * module, and a test in stratos-service keeps the two in step.
 *
 *   - space URI:  `at:space/{spaceDid}/{spaceType}/{skey}`
 *   - record URI: `at:space/{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
 *
 * After the exact prefix `at:space/` the text is split on `/` into exactly
 * three or six parts. Nothing is decoded, trimmed or case-folded, and no other
 * spelling is recognised. A space URI is not an `at://` URI: never give one to
 * a public-only parser such as `AtUri`.
 */

const SPACE_URI_PREFIX = 'at:space/'
const CUSTODY_URI_PREFIX = 'at://'
const CUSTODY_PART_COUNT = 3
const NOT_A_RECORD_ADDRESS = 'not a record address'
const SPACE_PART_COUNT = 3
const RECORD_PART_COUNT = 6

const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/
const UNESCAPED_PERCENT = /%(?![0-9A-Fa-f]{2})/
const NSID_PATTERN =
  /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?:\.[a-zA-Z](?:[a-zA-Z0-9]{0,62})?)$/
const RECORD_KEY_PATTERN = /^[a-zA-Z0-9_~.:-]{1,512}$/
const MAX_DID_LENGTH = 2048
const MAX_NSID_LENGTH = 253 + 1 + 63
const MIN_NSID_LENGTH = 5

export interface SpaceUriParts {
  spaceDid: string
  spaceType: string
  skey: string
}

export interface SpaceRecordUriParts extends SpaceUriParts {
  authorDid: string
  collection: string
  rkey: string
}

export interface SpaceRecordAddress {
  kind: 'space'
  authority: string
  spaceType: string
  skey: string
  author: string
  collection: string
  rkey: string
}

export interface CustodyRecordAddress {
  kind: 'custody'
  author: string
  collection: string
  rkey: string
}

export type RecordAddress = SpaceRecordAddress | CustodyRecordAddress

export type SpaceUriParseResult<T> =
  { ok: true; value: T } | { ok: false; reason: string }

export type BoundarySpaceUriResult =
  { ok: true; value: string } | { ok: false; reason: string }

const isUriDid = (value: string): boolean =>
  value.length <= MAX_DID_LENGTH &&
  DID_PATTERN.test(value) &&
  !UNESCAPED_PERCENT.test(value)

const isNsid = (value: string): boolean =>
  value.length >= MIN_NSID_LENGTH &&
  value.length <= MAX_NSID_LENGTH &&
  NSID_PATTERN.test(value)

const isRecordKey = (value: string): boolean =>
  value !== '.' && value !== '..' && RECORD_KEY_PATTERN.test(value)

const refuse = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason,
})

const refuseSpaceParts = (
  parts: SpaceUriParts,
): { ok: false; reason: string } | undefined => {
  if (!isUriDid(parts.spaceDid)) {
    return refuse(`invalid space DID: "${parts.spaceDid}"`)
  }
  if (!isNsid(parts.spaceType)) {
    return refuse(`invalid space type NSID: "${parts.spaceType}"`)
  }
  if (!isRecordKey(parts.skey)) {
    return refuse(`invalid skey: "${parts.skey}"`)
  }
  return undefined
}

const splitSpaceUri = (
  uri: string,
  expectedCount: number,
  label: string,
): SpaceUriParseResult<string[]> => {
  if (typeof uri !== 'string' || !uri.startsWith(SPACE_URI_PREFIX)) {
    return refuse(`${label} must start with "${SPACE_URI_PREFIX}"`)
  }
  const parts = uri.slice(SPACE_URI_PREFIX.length).split('/')
  if (parts.length !== expectedCount) {
    return refuse(
      `${label} must have ${expectedCount} components after "${SPACE_URI_PREFIX}", got ${parts.length}`,
    )
  }
  return { ok: true, value: parts }
}

/** Parses `at:space/{spaceDid}/{spaceType}/{skey}`; never throws. */
export const parseSpaceUri = (
  uri: string,
): SpaceUriParseResult<SpaceUriParts> => {
  const split = splitSpaceUri(uri, SPACE_PART_COUNT, 'space URI')
  if (!split.ok) return split
  const [spaceDid, spaceType, skey] = split.value
  const parts = { spaceDid, spaceType, skey }
  return refuseSpaceParts(parts) ?? { ok: true, value: parts }
}

/**
 * Parses `at:space/{spaceDid}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`;
 * never throws. The space authority and the record author stay in separate
 * fields.
 */
export const parseSpaceRecordUri = (
  uri: string,
): SpaceUriParseResult<SpaceRecordUriParts> => {
  const split = splitSpaceUri(uri, RECORD_PART_COUNT, 'record URI')
  if (!split.ok) return split
  const [spaceDid, spaceType, skey, authorDid, collection, rkey] = split.value
  const space = refuseSpaceParts({ spaceDid, spaceType, skey })
  if (space) return space
  if (!isUriDid(authorDid)) {
    return refuse(`invalid author DID: "${authorDid}"`)
  }
  if (!isNsid(collection)) {
    return refuse(`invalid collection NSID: "${collection}"`)
  }
  if (!isRecordKey(rkey)) return refuse(`invalid rkey: "${rkey}"`)
  return {
    ok: true,
    value: { spaceDid, spaceType, skey, authorDid, collection, rkey },
  }
}

const parseCustodyRecordUri = (
  uri: string,
): SpaceUriParseResult<CustodyRecordAddress> => {
  const parts = uri.slice(CUSTODY_URI_PREFIX.length).split('/')
  if (parts.length !== CUSTODY_PART_COUNT) return refuse(NOT_A_RECORD_ADDRESS)
  const [author, collection, rkey] = parts
  if (!isUriDid(author) || !isNsid(collection) || !isRecordKey(rkey)) {
    return refuse(NOT_A_RECORD_ADDRESS)
  }
  return { ok: true, value: { kind: 'custody', author, collection, rkey } }
}

/**
 * Classifies a record address: a space record URI, or the three-part
 * `at://{did}/{collection}/{rkey}` URI of a record in a Stratos-custody repo.
 * Anything else, including a handle authority, a query, a fragment or a
 * space URI, is refused with one plain reason. Nothing is decoded, trimmed or
 * case-folded. Never throws.
 */
export const parseRecordAddress = (
  uri: string,
): SpaceUriParseResult<RecordAddress> => {
  if (typeof uri !== 'string') return refuse(NOT_A_RECORD_ADDRESS)
  if (uri.startsWith(SPACE_URI_PREFIX)) {
    const record = parseSpaceRecordUri(uri)
    if (!record.ok) return refuse(NOT_A_RECORD_ADDRESS)
    const { spaceDid, authorDid, ...rest } = record.value
    return {
      ok: true,
      value: { kind: 'space', authority: spaceDid, author: authorDid, ...rest },
    }
  }
  if (uri.startsWith(CUSTODY_URI_PREFIX)) return parseCustodyRecordUri(uri)
  return refuse(NOT_A_RECORD_ADDRESS)
}

/**
 * Formats the space URI of a boundary, `at:space/{serviceDid}/{spaceType}/{name}`
 * for the boundary `{serviceDid}/{name}`. Same output as the stratos-core
 * function of the same name; the client cannot import core, so a test in
 * stratos-service keeps the two in step.
 */
export const boundaryToSpaceUri = (
  boundary: string,
  spaceType: string,
): BoundarySpaceUriResult => {
  const slash = boundary.indexOf('/')
  if (slash === -1) {
    return refuse(
      `boundary must be "{serviceDid}/{domainName}", got "${boundary}"`,
    )
  }
  const serviceDid = boundary.slice(0, slash)
  const name = boundary.slice(slash + 1)
  if (!isUriDid(serviceDid)) {
    return refuse(`invalid service DID: "${serviceDid}"`)
  }
  if (!isNsid(spaceType)) {
    return refuse(`invalid space type NSID: "${spaceType}"`)
  }
  if (!isRecordKey(name)) return refuse(`invalid boundary name: "${name}"`)
  return {
    ok: true,
    value: `${SPACE_URI_PREFIX}${serviceDid}/${spaceType}/${name}`,
  }
}
