import { CID } from '@atproto/lex-data'
import {
  S3BlobStore as AtprotoS3BlobStore,
  S3Config as AtprotoS3Config,
} from '@atproto/aws'
import {
  BlobNotFoundError,
  type BlobStore,
  type BlobStoreCreator,
} from '@northskysocial/stratos-core'
import { asyncIterableToReadable, readableToAsyncIterable } from './util.js'

/**
 * S3 configuration for stratos blob storage
 */
export interface S3Config {
  /** S3 bucket name */
  bucket: string
  /** AWS region (e.g., 'us-east-1') */
  region?: string
  /** S3 endpoint URL (for S3-compatible services like MinIO) */
  endpoint?: string
  /** Force path-style URLs (required for some S3-compatible services) */
  forcePathStyle?: boolean
  /** Access key ID for S3 authentication */
  accessKeyId?: string
  /** Secret access key for S3 authentication */
  secretAccessKey?: string
  /** Path prefix for blob keys (e.g., 'stratos/') */
  pathPrefix?: string
  /** Upload timeout in milliseconds */
  uploadTimeoutMs?: number
  /** Request timeout in milliseconds */
  requestTimeoutMs?: number
}

/**
 * S3-based blob storage adapter.
 *
 * Wraps @atproto/aws S3BlobStore to provide the stratos BlobStore interface.
 * Converts between Node.js Readable streams and AsyncIterable<Uint8Array>.
 *
 * Blobs are stored in the S3 bucket with the following key structure:
 * - {pathPrefix}blocks/{did}/{cid} - permanent blobs
 * - {pathPrefix}tmp/{did}/{key} - temporary blobs
 * - {pathPrefix}quarantine/{did}/{cid} - quarantined blobs
 */
export class S3BlobStoreAdapter implements BlobStore {
  private inner: AtprotoS3BlobStore

  constructor(did: string, cfg: S3Config) {
    // Build @atproto/aws config from our config
    // Note: pathPrefix is handled internally by prepending to blob keys
    const atprotoConfig: AtprotoS3Config = {
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      uploadTimeoutMs: cfg.uploadTimeoutMs,
      requestTimeoutMs: cfg.requestTimeoutMs,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
            }
          : undefined,
    }
    this.inner = new AtprotoS3BlobStore(did, atprotoConfig)
  }

  /**
   * Factory function for creating per-DID blob stores
   */
  static creator(cfg: S3Config): BlobStoreCreator {
    return (did: string) => new S3BlobStoreAdapter(did, cfg)
  }

  /**
   * Put temporary bytes to blob store
   *
   * @param bytes - Temporary bytes to store
   * @returns Key for the stored data
   */
  async putTemp(
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<string> {
    const input = !(Symbol.asyncIterator in bytes)
      ? bytes
      : asyncIterableToReadable(bytes)
    return this.inner.putTemp(input)
  }

  /**
   * Make temporary bytes permanent
   *
   * @param key - Key for the temporary data
   * @param cid - Content identifier for the permanent data
   */
  async makePermanent(key: string, cid: CID): Promise<void> {
    return this.inner.makePermanent(key, cid)
  }

  /**
   * Put permanent bytes to blob store
   *
   * @param cid - Content identifier for the permanent data
   * @param bytes - Permanent bytes to store
   */
  async putPermanent(
    cid: CID,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const input = !(Symbol.asyncIterator in bytes)
      ? bytes
      : asyncIterableToReadable(bytes)
    return this.inner.putPermanent(cid, input)
  }

  /**
   * Quarantine a blob
   *
   * @param cid - Content identifier for the blob to quarantine
   */
  async quarantine(cid: CID): Promise<void> {
    try {
      return await this.inner.quarantine(cid)
    } catch (err) {
      // Re-throw with our BlobNotFoundError for consistency
      if (isBlobNotFoundError(err)) {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Unquarantine a blob
   *
   * @param cid - Content identifier for the blob to unquarantine
   */
  async unquarantine(cid: CID): Promise<void> {
    try {
      return await this.inner.unquarantine(cid)
    } catch (err) {
      if (isBlobNotFoundError(err)) {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Get bytes from blob store
   *
   * @param cid - Content identifier for the blob to retrieve
   * @returns Bytes of the blob
   */
  async getBytes(cid: CID): Promise<Uint8Array> {
    try {
      return await this.inner.getBytes(cid)
    } catch (err) {
      if (isBlobNotFoundError(err)) {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Get a stream of bytes from blob store
   *
   * @param cid - Content identifier for the blob to retrieve
   * @returns Async iterable of bytes
   */
  async getStream(cid: CID): Promise<AsyncIterable<Uint8Array>> {
    try {
      const readable = await this.inner.getStream(cid)
      return readableToAsyncIterable(readable)
    } catch (err) {
      if (isBlobNotFoundError(err)) {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Check if a blob exists in the blob store
   *
   * @param key - Key for the blob to check
   * @returns True if the blob exists, false otherwise
   */
  async hasTemp(key: string): Promise<boolean> {
    return this.inner.hasTemp(key)
  }

  /**
   * Check if a blob exists in the blob store
   *
   * @param cid - Content identifier for the blob to check
   * @returns True if the blob exists, false otherwise
   */
  async hasStored(cid: CID): Promise<boolean> {
    return this.inner.hasStored(cid)
  }

  /**
   * Delete a blob from the blob store
   *
   * @param cid - Content identifier for the blob to delete
   */
  async delete(cid: CID): Promise<void> {
    return this.inner.delete(cid)
  }

  /**
   * Delete multiple blobs from the blob store
   *
   * @param cids - Content identifiers for the blobs to delete
   */
  async deleteMany(cids: CID[]): Promise<void> {
    return this.inner.deleteMany(cids)
  }
}

/**
 * Check if an error is a BlobNotFoundError from @atproto/repo
 *
 * @param err - Error to check
 * @returns True if the error is a BlobNotFoundError, false otherwise
 */
function isBlobNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.name === 'BlobNotFoundError'
}
