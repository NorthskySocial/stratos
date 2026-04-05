import { Cid } from '@atproto/lex-data'

/**
 * Descriptor for a stratos record
 */
export interface RecordDescript {
  uri: string
  cid: Cid
  collection: string
  rkey: string
}

/**
 * Record with its value and metadata
 */
export interface RecordValue {
  uri: string
  cid: string
  value: Record<string, unknown>
  indexedAt: string
  takedownRef: string | null
}

/**
 * Options for listing records in a collection
 */
export interface ListRecordsOptions {
  collection: string
  limit: number
  reverse?: boolean
  cursor?: string
  rkeyStart?: string
  rkeyEnd?: string
  includeSoftDeleted?: boolean
}

/**
 * Options for getting a single record
 */
export interface GetRecordOptions {
  uri: string
  includeSoftDeleted?: boolean
}

/**
 * Port interface for reading records
 */
export interface RecordStoreReader {
  /** Get total record count */
  recordCount: () => Promise<number>

  /** List all records */
  listAll: () => Promise<RecordDescript[]>

  /** List records in a collection */
  listRecords: (options: ListRecordsOptions) => Promise<RecordValue[]>

  /** Get a single record by URI */
  getRecord: (options: GetRecordOptions) => Promise<RecordValue | null>

  /** Check if a record exists */
  hasRecord: (uri: string) => Promise<boolean>

  /** Get record content bytes by CID */
  getRecordContent: (cid: Cid) => Promise<Uint8Array | null>
}

/**
 * Port interface for writing records
 */
export interface RecordStoreWriter extends RecordStoreReader {
  /** Create or update a record */
  putRecord: (record: {
    uri: string
    cid: Cid
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }) => Promise<void>

  /** Delete a record */
  deleteRecord: (uri: string) => Promise<void>

  /** Soft delete (takedown) a record */
  takedownRecord: (uri: string, takedownRef: string) => Promise<void>

  /** Restore a soft-deleted record */
  restoreRecord: (uri: string) => Promise<void>
}
