import { Cid } from '@atproto/lex-data'

/**
 * Blob metadata stored in the database
 */
export interface BlobMetadata {
  cid: Cid
  mimeType: string
  size: number
  tempKey?: string | null
  width?: number
  height?: number
  createdAt: string
  takedownRef?: string
}

/**
 * Port interface for reading blob metadata
 */
export interface BlobMetadataReader {
  /** Get blob metadata */
  getBlobMetadata: (cid: Cid) => Promise<BlobMetadata | null>

  /** Check if blob exists */
  hasBlob: (cid: Cid) => Promise<boolean>

  /** List blobs for a record */
  listBlobsForRecord: (recordUri: string) => Promise<BlobMetadata[]>

  /** List all blob CIDs */
  listAllBlobCids: () => Promise<Cid[]>

  /** List records associated with a blob */
  listRecordsForBlob: (blobCid: Cid) => Promise<string[]>

  /** Get boundaries associated with a blob */
  getBoundariesForBlob: (blobCid: Cid) => Promise<string[]>
}

/**
 * Port interface for writing blob metadata
 */
export interface BlobMetadataWriter extends BlobMetadataReader {
  /** Track a new blob in the database */
  trackBlob: (blob: {
    cid: Cid
    mimeType: string
    size: number
    tempKey?: string | null
    width?: number | null
    height?: number | null
  }) => Promise<void>

  /** Associate blob with a record */
  associateBlobWithRecord: (blobCid: Cid, recordUri: string) => Promise<void>

  /** Remove record associations for a blob */
  removeRecordBlobAssociations: (recordUri: string) => Promise<void>

  /** Delete blob metadata */
  deleteBlob: (cid: Cid) => Promise<void>

  /** Takedown blob */
  takedownBlob: (cid: Cid, takedownRef: string) => Promise<void>

  /** Restore a taken-down blob */
  restoreBlob: (cid: Cid) => Promise<void>

  /** Associate blob with a boundary */
  associateBlobWithBoundary: (blobCid: Cid, boundary: string) => Promise<void>

  /** Remove boundary associations for a blob */
  removeBlobBoundaryAssociations: (blobCid: Cid) => Promise<void>
}

/**
 * Port interface for blob content storage (filesystem/S3/etc.)
 * This is separate from metadata storage
 */
export interface BlobContentStore {
  /** Store blob bytes temporarily */
  putTemp: (bytes: Uint8Array) => Promise<string>

  /** Make a temporary blob permanent */
  makePermanent: (tempKey: string, cid: Cid) => Promise<void>

  /** Get blob bytes by CID */
  getBytes: (cid: Cid) => Promise<Uint8Array | null>

  /** Check if blob content exists */
  hasStored: (cid: Cid) => Promise<boolean>

  /** Delete blob content */
  deleteContent: (cid: Cid) => Promise<void>

  /** Get blob content as a stream */
  getStream: (cid: Cid) => Promise<ReadableStream<Uint8Array> | null>
}
