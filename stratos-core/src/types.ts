import { CID } from 'multiformats/cid'

export enum ENROLLMENT_MODE {
  OPEN = 'open',
  ALLOWLIST = 'allowlist',
}

/**
 * Configuration for stratos domain validation
 */
export interface StratosConfig {
  /** List of allowed boundary domain values */
  allowedDomains: string[]
  /** Days to retain stratos data after account deactivation */
  retentionDays: number
}

/**
 * Enrollment configuration for the stratos service
 */
export interface EnrollmentConfig {
  /** Enrollment mode: 'open' allows anyone, 'allowlist' restricts to configured DIDs/PDS */
  mode: ENROLLMENT_MODE
  /** Explicit list of DIDs allowed to enroll */
  allowedDids?: string[]
  /** List of PDS endpoints whose users are allowed to enroll */
  allowedPdsEndpoints?: string[]
  /** Domains to automatically enroll users to */
  autoEnrollDomains?: string[]
}

/**
 * Status attribute for takedown state
 */
export interface StatusAttr {
  applied: boolean
  ref?: string
}

/**
 * Background queue interface for async operations
 */
export interface BackgroundQueue {
  add(name: string, task: () => Promise<void>): void
}

/**
 * Logger interface for dependency injection
 */
export interface Logger {
  debug(obj: object | string, msg?: string): void
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

/**
 * Error thrown when a blob is not found in storage
 */
export class BlobNotFoundError extends Error {
  constructor(message = 'Blob not found') {
    super(message)
    this.name = 'BlobNotFoundError'
  }
}

/**
 * Blob store interface for content-addressed storage.
 * This is the "port" in hexagonal architecture - adapters implement this interface.
 */
export interface BlobStore {
  /** Upload bytes to temporary storage, returns a key for later reference */
  putTemp(bytes: Uint8Array | AsyncIterable<Uint8Array>): Promise<string>
  /** Move a temporary blob to permanent storage */
  makePermanent(key: string, cid: CID): Promise<void>
  /** Upload bytes directly to permanent storage */
  putPermanent(
    cid: CID,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void>
  /** Move a blob to quarantine (for takedowns) */
  quarantine(cid: CID): Promise<void>
  /** Restore a blob from quarantine */
  unquarantine(cid: CID): Promise<void>
  /** Delete a blob from storage */
  delete(cid: CID): Promise<void>
  /** Delete multiple blobs from storage */
  deleteMany(cids: CID[]): Promise<void>
  /** Check if a temporary blob exists */
  hasTemp(key: string): Promise<boolean>
  /** Check if a permanent blob exists */
  hasStored(cid: CID): Promise<boolean>
  /** Get blob contents as bytes */
  getBytes(cid: CID): Promise<Uint8Array>
  /** Get blob contents as a stream */
  getStream(cid: CID): Promise<AsyncIterable<Uint8Array>>
}

/**
 * Factory function type for creating per-DID blob stores
 */
export type BlobStoreCreator = (did: string) => BlobStore

/**
 * Write operation action type
 */
export type WriteOpAction = 'create' | 'update' | 'delete'

/**
 * Prepared write operation
 */
export interface PreparedWrite {
  action: WriteOpAction
  uri: string
  cid: CID | null
  swapCid: CID | undefined
  record: Record<string, unknown> | null
  blobs: PreparedBlobRef[]
}

/**
 * Prepared create operation
 */
export interface PreparedCreate {
  action: 'create'
  uri: string
  cid: CID
  swapCid: undefined
  record: Record<string, unknown>
  blobs: PreparedBlobRef[]
}

/**
 * Prepared update operation
 */
export interface PreparedUpdate {
  action: 'update'
  uri: string
  cid: CID
  swapCid: CID | undefined
  record: Record<string, unknown>
  blobs: PreparedBlobRef[]
}

/**
 * Prepared delete operation
 */
export interface PreparedDelete {
  action: 'delete'
  uri: string
  cid: null
  swapCid: CID | undefined
  record: null
  blobs: []
}

/**
 * Prepared blob reference
 */
export interface PreparedBlobRef {
  cid: CID
  mimeType: string
  constraints: BlobConstraints
  tempKey?: string
}

/**
 * Blob constraints from lexicon
 */
export interface BlobConstraints {
  accept?: string[]
  maxSize?: number
}

/**
 * Commit operation for sequencer
 */
export interface CommitOp {
  action: WriteOpAction
  path: string
  cid: CID | null
  record: Record<string, unknown> | null
}

/**
 * Commit data with operations
 */
export interface CommitData {
  cid: CID
  rev: string
  since: string | null
  prev: CID | null
  newBlocks: Map<string, Uint8Array>
  relevantBlocks: Map<string, Uint8Array>
  removedCids: Set<string>
}

/**
 * Commit data with operations for sequencing
 */
export interface CommitDataWithOps extends CommitData {
  ops: CommitOp[]
}

/**
 * Record row from database
 */
export interface RecordRow {
  uri: string
  cid: string
  collection: string
  rkey: string
  repoRev: string | null
  indexedAt: string
  takedownRef: string | null
}

/**
 * Blob row from database
 */
export interface BlobRow {
  cid: string
  mimeType: string
  size: number
  createdAt: string
  takedownRef: string | null
}

/**
 * Backlink reference
 */
export interface Backlink {
  path: string
  linkTo: string
}

/**
 * Options for getting backlinks
 */
export interface BacklinkOpts {
  collection: string
  path: string
  linkTo: string
  limit?: number
  cursor?: string
}

/**
 * Stratos validation error
 */
export class StratosValidationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
    this.name = 'StratosValidationError'
  }
}
