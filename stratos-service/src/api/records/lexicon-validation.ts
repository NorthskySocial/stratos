import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  InvalidLexiconError,
  LexiconDefNotFoundError,
  Lexicons,
  ValidationError,
} from '@atproto/lexicon'
import { parseRecordUri, stratosLexicons } from '@northskysocial/stratos-core'

const DOMAINS_TYPE = 'zone.stratos.boundary.defs#Domains'
const STRONG_REF = 'com.atproto.repo.strongRef'

// References sit near the top of a record; the bound keeps a hostile nesting
// from exhausting the stack.
const MAX_REFERENCE_DEPTH = 16

export type LexiconValidationStatus = 'valid' | 'unknown'

/**
 * How a boundary write treats the lexicon of a record. The status is
 * undefined when no check ran.
 */
export type LexiconCheck = (
  collection: string,
  record: Record<string, unknown>,
) => LexiconValidationStatus | undefined

const lexicons = new Lexicons(stratosLexicons)

/**
 * Checks that a record names the collection it is written to. A record
 * without a string `$type` cannot be decoded when it is read back.
 * @throws InvalidRequestError `InvalidRecord` when `$type` is missing or differs
 */
export function assertRecordTypeMatches(
  record: Record<string, unknown>,
  collection: string,
): void {
  const { $type: recordType } = record
  if (recordType === collection) return
  const found = typeof recordType === 'string' ? recordType : 'none'
  throw new InvalidRequestError(
    `The record $type (${found}) must equal its collection ${collection}`,
    'InvalidRecord',
  )
}

/** The caller asked for no lexicon check. */
export function skipLexiconValidation(): undefined {
  return undefined
}

/**
 * Validates a record whose lexicon the provider holds; a record of any other
 * collection is accepted as unknown.
 * @throws InvalidRequestError `InvalidRecord` when a known lexicon rejects the record
 */
export function validateIfKnown(
  collection: string,
  record: Record<string, unknown>,
): LexiconValidationStatus {
  if (!isKnownRecordLexicon(collection)) return 'unknown'
  assertMatchesLexicon(collection, record)
  return 'valid'
}

/**
 * Validates a record and refuses a collection the provider holds no lexicon for.
 * @throws InvalidRequestError `InvalidRecord` when the lexicon is unknown or rejects the record
 */
export function requireLexiconValidation(
  collection: string,
  record: Record<string, unknown>,
): LexiconValidationStatus {
  if (!isKnownRecordLexicon(collection)) {
    throw new InvalidRequestError(
      `Unknown lexicon type: ${collection}`,
      'InvalidRecord',
    )
  }
  assertMatchesLexicon(collection, record)
  return 'valid'
}

/**
 * Whether a value is a reference the strongRef lexicon accepts, reading a
 * space record URI in its repo form as the record check does.
 */
export function isWellFormedStrongRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return lexicons.validate(STRONG_REF, rewriteUris(value, 0)).success
}

function isKnownRecordLexicon(collection: string): boolean {
  return lexicons.getDef(collection)?.type === 'record'
}

function assertMatchesLexicon(
  collection: string,
  record: Record<string, unknown>,
): void {
  try {
    lexicons.assertValidRecord(
      collection,
      withTypedBoundaryClaim(withRepoFormUris(record)),
    )
  } catch (err) {
    // A missing or invalid definition means the provider itself is broken, not
    // the record, so it stays a server error instead of blaming the caller.
    if (
      err instanceof LexiconDefNotFoundError ||
      err instanceof InvalidLexiconError
    ) {
      throw err
    }
    // The library also throws plain errors for a malformed union `$type`; its
    // text would echo the caller's value, so only a validation error's text is shown.
    const detail =
      err instanceof ValidationError
        ? err.message
        : 'the record could not be validated'
    throw new InvalidRequestError(
      `Invalid ${collection} record: ${detail}`,
      'InvalidRecord',
    )
  }
}

// The boundary union needs its $type to be checked; the stored body keeps the
// claim as the writer sent it.
function withTypedBoundaryClaim(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const claim = record.boundary
  if (
    typeof claim !== 'object' ||
    claim === null ||
    Array.isArray(claim) ||
    '$type' in claim
  ) {
    return record
  }
  return { ...record, boundary: { $type: DOMAINS_TYPE, ...claim } }
}

// The lexicon library's at-uri format does not know space record URIs yet, so
// the check sees a copy in which each `uri` property holding one names the same
// record in repo form. Only this copy is changed; the stored record keeps the
// URI the client sent. Exported so tests can pin the depth bound.
export function withRepoFormUris(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return rewriteUris(record, 0) as Record<string, unknown>
}

function rewriteUris(value: unknown, depth: number): unknown {
  if (depth > MAX_REFERENCE_DEPTH) return value
  if (Array.isArray(value)) {
    return value.map((item) => rewriteUris(item, depth + 1))
  }
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'uri' && typeof child === 'string'
        ? repoFormOf(child)
        : rewriteUris(child, depth + 1),
    ]),
  )
}

function repoFormOf(uri: string): string {
  const parsed = parseRecordUri(uri)
  if (!parsed.ok) return uri
  const { authorDid, collection, rkey } = parsed.value
  return `at://${authorDid}/${collection}/${rkey}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
