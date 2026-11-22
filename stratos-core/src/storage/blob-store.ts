import { Cid } from '@atproto/lex-data'

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
