import {CID} from 'multiformats/cid'
import type {Readable} from 'node:stream'

/**
 * Blob metadata stored in the database
 */
export interface BlobMetadata {
  cid: CID
  mimeType: string
  size: number
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
  getBlobMetadata(cid: CID): Promise<BlobMetadata | null>

  /** Check if blob exists */
  hasBlob(cid: CID): Promise<boolean>

  /** List blobs for a record */
  listBlobsForRecord(recordUri: string): Promise<BlobMetadata[]>

  /** List all blob CIDs */
  listAllBlobCids(): Promise<CID[]>
}

/**
 * Port interface for writing blob metadata
 */
export interface BlobMetadataWriter extends BlobMetadataReader {
  /** Track a new blob in the database */
  trackBlob(blob: {
    cid: CID
    mimeType: string
    size: number
    tempKey?: string | null
    width?: number | null
    height?: number | null
  }): Promise<void>

  /** Associate blob with a record */
  associateBlobWithRecord(blobCid: CID, recordUri: string): Promise<void>

  /** Remove record associations for a blob */
  removeRecordBlobAssociations(recordUri: string): Promise<void>

  /** Delete blob metadata */
  deleteBlob(cid: CID): Promise<void>

  /** Takedown blob */
  takedownBlob(cid: CID, takedownRef: string): Promise<void>

  /** Restore a taken-down blob */
  restoreBlob(cid: CID): Promise<void>
}

/**
 * Port interface for blob content storage (filesystem/S3/etc.)
 * This is separate from metadata storage
 */
export interface BlobContentStore {
  /** Store blob bytes temporarily */
  putTemp(bytes: Buffer | Readable): Promise<string>

  /** Make a temporary blob permanent */
  makePermanent(tempKey: string, cid: CID): Promise<void>

  /** Get blob bytes by CID */
  getBytes(cid: CID): Promise<Buffer | null>

  /** Check if blob content exists */
  hasStored(cid: CID): Promise<boolean>

  /** Delete blob content */
  deleteContent(cid: CID): Promise<void>

  /** Get blob content as a stream */
  getStream(cid: CID): Promise<ReadableStream<Buffer> | null>
}
