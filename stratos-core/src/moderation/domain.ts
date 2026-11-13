import { parseCid } from '../atproto/index.js'
import {
  AT_SCHEME,
  formatSpaceUri,
  isSyntacticDid,
  isValidNsidStr,
  isValidRkey,
  parseRecordUri,
  SPACE_SEGMENT,
  spaceUriToBoundary,
} from '../spaces/index.js'
import type { RecordUri, SpacesError } from '../spaces/index.js'
import type {
  ExistingLabel,
  LabelDecision,
  LabelRequest,
  LabelSubjectInput,
  ModerationError,
  ModerationErrorCode,
  ModerationResult,
  ParsedLabelSubject,
} from './types.js'

export const RECORD_SUBJECT_TYPE = 'zone.stratos.moderation.defs#recordSubject'
export const ACCOUNT_SUBJECT_TYPE =
  'zone.stratos.moderation.defs#accountSubject'
export const TAKEDOWN_VALUE = '!takedown'

const REPO_URI_COMPONENT_COUNT = 3
const SPACE_MARKER_INDEX = 1

function fail(
  code: ModerationErrorCode,
  message: string,
  spaces?: SpacesError,
): { ok: false; error: ModerationError } {
  const error: ModerationError = spaces
    ? {
        code,
        message: `${message}: ${spaces.message}`,
        spacesCode: spaces.code,
      }
    : { code, message }
  return { ok: false, error }
}

function invalidSubject(message: string, spaces?: SpacesError) {
  return fail('invalid-subject', message, spaces)
}

function isValidCid(value: string): boolean {
  try {
    parseCid(value)
    return true
  } catch {
    return false
  }
}

function parseHostedRecordUri(
  uri: string,
): ModerationResult<{ authorDid: string; collection: string; rkey: string }> {
  if (!uri.startsWith(AT_SCHEME)) {
    return invalidSubject(`subject URI must start with "${AT_SCHEME}"`)
  }
  const parts = uri.slice(AT_SCHEME.length).split('/')
  if (parts.length !== REPO_URI_COMPONENT_COUNT) {
    return invalidSubject(
      `subject URI must be at://{did}/{collection}/{rkey}, got ${parts.length} components`,
    )
  }
  const [authorDid, collection, rkey] = parts
  if (!isSyntacticDid(authorDid)) {
    return invalidSubject(`subject authority is not a DID: "${authorDid}"`)
  }
  if (!isValidNsidStr(collection)) {
    return invalidSubject(`invalid collection NSID: "${collection}"`)
  }
  if (!isValidRkey(rkey)) {
    return invalidSubject(`invalid rkey: "${rkey}"`)
  }
  return { ok: true, value: { authorDid, collection, rkey } }
}

function parseRecordSubject(
  uri: string,
  cid: string | undefined,
): ModerationResult<ParsedLabelSubject> {
  const pinned = cid === undefined ? {} : { cid }
  const isSpaceForm =
    uri.startsWith(AT_SCHEME) &&
    uri.slice(AT_SCHEME.length).split('/')[SPACE_MARKER_INDEX] === SPACE_SEGMENT
  if (isSpaceForm) {
    const record = parseRecordUri(uri)
    if (!record.ok) {
      return invalidSubject('invalid space record URI', record.error)
    }
    return {
      ok: true,
      value: { kind: 'space-record', uri, record: record.value, ...pinned },
    }
  }
  const hosted = parseHostedRecordUri(uri)
  if (!hosted.ok) return hosted
  return {
    ok: true,
    value: { kind: 'hosted-record', uri, ...hosted.value, ...pinned },
  }
}

export function parseLabelSubject(
  input: LabelSubjectInput,
): ModerationResult<ParsedLabelSubject> {
  if (input.$type === ACCOUNT_SUBJECT_TYPE) {
    if (typeof input.did !== 'string' || !isSyntacticDid(input.did)) {
      return invalidSubject('account subject must carry a DID')
    }
    return { ok: true, value: { kind: 'account', did: input.did } }
  }
  if (input.$type !== RECORD_SUBJECT_TYPE) {
    return invalidSubject(`unknown subject type: "${input.$type}"`)
  }
  if (typeof input.uri !== 'string') {
    return invalidSubject('record subject must carry a uri')
  }
  if (input.cid !== undefined && !isValidCid(input.cid)) {
    return invalidSubject(`invalid cid: "${input.cid}"`)
  }
  return parseRecordSubject(input.uri, input.cid)
}

export function validateLabelValue(val: string): ModerationResult<string> {
  if (val !== TAKEDOWN_VALUE) {
    return fail('invalid-value', `only "${TAKEDOWN_VALUE}" is supported`)
  }
  return { ok: true, value: val }
}

/** Never empty: a takedown without a usable ref is identified by its seq. */
export function takedownMarker(label: { seq: number; ref?: string }): string {
  return label.ref !== undefined && label.ref !== ''
    ? label.ref
    : String(label.seq)
}

function normalizeRef(ref: string | undefined): string {
  return ref ?? ''
}

export function decideLabelAction<L extends ExistingLabel>(
  latest: L | undefined,
  request: LabelRequest,
): LabelDecision<L> {
  if (request.neg) {
    if (latest === undefined) return { kind: 'no-change' }
    return latest.neg
      ? { kind: 'return-existing', label: latest }
      : { kind: 'append' }
  }
  const isRepeat =
    latest !== undefined &&
    !latest.neg &&
    normalizeRef(latest.ref) === normalizeRef(request.ref)
  return isRepeat
    ? { kind: 'return-existing', label: latest }
    : { kind: 'append' }
}

export function spaceSubjectBoundary(
  record: RecordUri,
  serviceDid: string,
): ModerationResult<string> {
  // The input is an already-parsed RecordUri, so this cannot fail in practice;
  // the format stays owned by `spaces`.
  const space = formatSpaceUri(record)
  if (!space.ok) {
    return invalidSubject('invalid space in record URI', space.error)
  }
  const boundary = spaceUriToBoundary(space.value, serviceDid)
  if (!boundary.ok) {
    return fail(
      'foreign-authority',
      'space is not owned by this service',
      boundary.error,
    )
  }
  return boundary
}

/** Record URIs start with "at://" and DIDs with "did:", so keys never collide. */
export function labelSubjectKey(subject: ParsedLabelSubject): string {
  return subject.kind === 'account' ? subject.did : subject.uri
}
