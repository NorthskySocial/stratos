import type { RecordUri, SpacesErrorCode } from '../spaces/index.js'

export type ModerationErrorCode =
  | 'invalid-subject'
  | 'unsupported-cid'
  | 'invalid-value'
  | 'foreign-authority'
  | 'invalid-cursor'

export interface ModerationError {
  code: ModerationErrorCode
  message: string
  /** Set when the failure originated in the spaces URI helpers. */
  spacesCode?: SpacesErrorCode
}

export type ModerationResult<T> =
  { ok: true; value: T } | { ok: false; error: ModerationError }

/** Wire shape of the lexicon subject union, before validation. */
export interface LabelSubjectInput {
  $type: string
  uri?: string
  did?: string
  cid?: string
}

export type ParsedLabelSubject =
  | {
      kind: 'hosted-record'
      uri: string
      authorDid: string
      collection: string
      rkey: string
    }
  | { kind: 'space-record'; uri: string; record: RecordUri }
  | { kind: 'account'; did: string }

export interface ExistingLabel {
  seq: number
  neg: boolean
  ref?: string
}

export interface LabelRequest {
  neg: boolean
  ref?: string
}

export type LabelDecision<L extends ExistingLabel = ExistingLabel> =
  | { kind: 'append' }
  | { kind: 'return-existing'; label: L }
  | { kind: 'no-change' }

export type LabelSubjectKind = 'record' | 'account'

export interface StoredLabel extends ExistingLabel {
  /** Value of `labelSubjectKey` for the subject this label applies to. */
  subjectKey: string
  subjectKind: LabelSubjectKind
  /** Only on labels stored before createLabel refused a subject cid. */
  cid?: string
  val: string
  /** Sorted and deduplicated; empty for an account label. */
  boundaries: string[]
  /** DID of the moderation service that issued the label. */
  createdBy: string
  createdAt: string
}

export type NewLabel = Omit<StoredLabel, 'seq'>
