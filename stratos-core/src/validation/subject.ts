import { AtUri, ensureValidAtUri } from '@atproto/syntax'
import type { Custody } from '../enrollment/types.js'
import {
  formatRecordUri,
  isSyntacticDid,
  isValidNsidStr,
  isValidRkey,
  parseRecordUri,
} from '../spaces/domain.js'
import type { RecordUri } from '../spaces/types.js'
import { qualifyBoundary } from './boundary-qualification.js'

/** The one answer for every way a subject can fail, so no failure tells itself apart. */
export const SUBJECT_ERROR_MESSAGE =
  'The subject must be a post in this boundary'

/** What the write itself requires of a subject. */
export interface ExpectedSubject {
  boundary: string
  serviceDid: string
  spaceType: string
  collections: readonly string[]
  /** The cid the record claims for its subject; absent when it claims none. */
  cid: string | undefined
}

/** A subject named as a record in a repo Stratos hosts. */
export interface RepoSubjectFacts {
  form: 'repo'
  uri: string
  author: string
  collection: string
  storedCid: string
  /** The stored boundary rows of the subject, not any claim in its body. */
  boundaries: string[]
  authorActive: boolean
  authorCustody: Custody
}

/** A subject named as a record in a space, for an author whose repo is at a pds. */
export interface SpaceSubjectFacts {
  form: 'space'
  uri: string
  authority: string
  spaceType: string
  skey: string
  author: string
  collection: string
  authorActive: boolean
  authorCustody: Custody
  authorBoundaries: string[]
}

/** Anything that is not a resolvable subject; the cause is never told apart. */
export interface UnresolvableSubjectFacts {
  form: 'unresolvable'
}

export type SubjectFacts =
  | RepoSubjectFacts
  | SpaceSubjectFacts
  | UnresolvableSubjectFacts

/**
 * Parses a record URI whose authority is a DID and that is spelled exactly as
 * it would be rebuilt from its parts. The URI is the key a backlink is stored
 * under, so a record must have one spelling.
 * @returns the parts, or null for any other string
 */
export function parseCanonicalRepoUri(
  uri: string,
): { author: string; collection: string; rkey: string } | null {
  try {
    ensureValidAtUri(uri)
    const parsed = new AtUri(uri)
    const { hostname: author, collection, rkey } = parsed
    if (
      !isSyntacticDid(author) ||
      !isValidNsidStr(collection) ||
      !isValidRkey(rkey)
    ) {
      return null
    }
    return AtUri.make(author, collection, rkey).toString() === uri
      ? { author, collection, rkey }
      : null
  } catch {
    return null
  }
}

/**
 * Parses a space record URI that is spelled exactly as it would be formatted
 * from its parts.
 * @returns the parts, or null for any other string
 */
export function parseCanonicalSpaceRecordUri(uri: string): RecordUri | null {
  const parsed = parseRecordUri(uri)
  if (!parsed.ok) return null
  const formatted = formatRecordUri(parsed.value)
  return formatted.ok && formatted.value === uri ? parsed.value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function includesBoundary(boundaries: unknown, boundary: string): boolean {
  return Array.isArray(boundaries) && boundaries.includes(boundary)
}

function isEligibleRepoSubject(
  facts: RepoSubjectFacts,
  expected: ExpectedSubject,
): boolean {
  if (typeof facts.uri !== 'string') return false
  const parts = parseCanonicalRepoUri(facts.uri)
  if (!parts) return false
  return (
    parts.author === facts.author &&
    parts.collection === facts.collection &&
    expected.collections.includes(facts.collection) &&
    expected.cid !== undefined &&
    expected.cid === facts.storedCid &&
    Array.isArray(facts.boundaries) &&
    facts.boundaries.length === 1 &&
    facts.boundaries[0] === expected.boundary &&
    facts.authorActive === true &&
    facts.authorCustody === 'stratos'
  )
}

function isEligibleSpaceSubject(
  facts: SpaceSubjectFacts,
  expected: ExpectedSubject,
): boolean {
  if (typeof facts.uri !== 'string') return false
  const parts = parseCanonicalSpaceRecordUri(facts.uri)
  if (!parts) return false
  return (
    parts.spaceDid === facts.authority &&
    parts.spaceType === facts.spaceType &&
    parts.skey === facts.skey &&
    parts.authorDid === facts.author &&
    parts.collection === facts.collection &&
    facts.authority === expected.serviceDid &&
    facts.spaceType === expected.spaceType &&
    qualifyBoundary(facts.authority, facts.skey) === expected.boundary &&
    expected.collections.includes(facts.collection) &&
    facts.authorActive === true &&
    facts.authorCustody === 'pds' &&
    includesBoundary(facts.authorBoundaries, expected.boundary)
  )
}

/**
 * Whether a like or repost may name this subject. Every reason a subject can
 * fail answers false, so a caller can give one answer for all of them.
 */
export function isEligibleSubject(
  facts: SubjectFacts,
  expected: ExpectedSubject,
): boolean {
  if (!isRecord(facts)) return false
  if (facts.form === 'repo') return isEligibleRepoSubject(facts, expected)
  if (facts.form === 'space') return isEligibleSpaceSubject(facts, expected)
  return false
}
