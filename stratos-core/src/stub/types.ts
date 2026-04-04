import { type Cid } from '@atproto/lex-data'

/**
 * Source field for stub records - indicates where to hydrate full content
 */
export interface RecordSource {
  /** When hydration is needed. 'authenticated' requires viewer auth. */
  vary: 'authenticated' | 'unauthenticated'
  /** Reference to full record at hydration service */
  subject: SubjectRef
  /** DID with fragment pointing to service entry (e.g., 'did:plc:abc#atproto_pns') */
  service: string
}

/**
 * Strong reference to a record with content hash
 */
export interface SubjectRef {
  /** AT-URI of the record */
  uri: string
  /** CID of the full record for integrity verification */
  cid: string
}

/**
 * A stub record that appears on the user's PDS
 * Contains minimal metadata plus source field for hydration
 */
export interface StubRecord {
  $type: string
  /** Source field indicating hydration is required */
  source: RecordSource
  /** Timestamp preserved from full record */
  createdAt: string
}

/**
 * Full record stored in Stratos with boundary
 */
export interface FullRecordWithBoundary {
  $type: string
  /** The full record value */
  value: Record<string, unknown>
  /** CID of the record */
  cid: Cid
  /** Boundaries that restrict access */
  boundaries: string[]
}

/**
 * Input for generating a stub from a full record
 */
export interface GenerateStubInput {
  /** AT-URI of the record */
  uri: string
  /** CID of the full record */
  cid: Cid
  /** The full record type ($type) */
  recordType: string
  /** Timestamp from full record */
  createdAt: string
  /** Service DID with fragment (e.g., 'did:plc:abc#atproto_pns') */
  serviceDid: string
}
