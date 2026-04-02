import fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { Cid } from '@atproto/lex-data'
import {
  aggregateErrors,
  chunkArray,
  fileExists,
  rmIfExists,
} from '@atproto/common'
import { randomStr } from '@atproto/crypto'
import {
  BlobNotFoundError,
  type BlobStore,
  type BlobStoreCreator,
} from '@northskysocial/stratos-core'
import { collectAsyncIterable, readableToAsyncIterable } from './util.js'

/**
 * Disk-based blob storage adapter.
 *
 * Implements the BlobStore port using the local filesystem.
 * Blobs are stored in per-DID directories with the following structure:
 * - {location}/{did}/{cid} - permanent blobs
 * - {tmpLocation}/{did}/{key} - temporary blobs
 * - {quarantineLocation}/{did}/{cid} - quarantined blobs
 */
export class DiskBlobStore implements BlobStore {
  constructor(
    public did: string,
    public location: string,
    public tmpLocation: string,
    public quarantineLocation: string,
  ) {}

  /**
   * Factory function for creating per-DID blob stores
   *
   * @param location - Base location for blob storage
   * @param tmpLocation - Temporary blob storage location
   * @param quarantineLocation - Quarantine blob storage location
   * @returns Blob store creator function
   */
  static creator(
    location: string,
    tmpLocation?: string,
    quarantineLocation?: string,
  ): BlobStoreCreator {
    return (did: string) => {
      const tmp = tmpLocation ?? path.join(location, 'temp')
      const quarantine = quarantineLocation ?? path.join(location, 'quarantine')
      return new DiskBlobStore(did, location, tmp, quarantine)
    }
  }

  /**
   * Get the temporary path for a given key
   *
   * @param key - Key for temporary storage
   * @returns Temporary path for the key
   */
  getTmpPath(key: string): string {
    return path.join(this.tmpLocation, this.did, key)
  }

  /**
   * Get stored path for a given CID
   *
   * @param cid - Content identifier
   * @returns Stored path for the CID
   */
  getStoredPath(cid: Cid): string {
    return path.join(this.location, this.did, cid.toString())
  }

  /**
   * Get quarantine path for a given CID
   *
   * @param cid - Content identifier
   * @returns Quarantine path for the CID
   */
  getQuarantinePath(cid: Cid): string {
    return path.join(this.quarantineLocation, this.did, cid.toString())
  }

  /**
   * Check if temporary storage has a file for a given key
   *
   * @param key - Key for temporary storage
   * @returns True if temporary storage has the file, false otherwise
   */
  async hasTemp(key: string): Promise<boolean> {
    return fileExists(this.getTmpPath(key))
  }

  /**
   * Check if stored storage has a file for a given CID
   *
   * @param cid - Content identifier
   * @returns True if stored storage has the file, false otherwise
   */
  async hasStored(cid: Cid): Promise<boolean> {
    return fileExists(this.getStoredPath(cid))
  }

  /**
   * Store temporary data in disk storage
   *
   * @param bytes - Data to store
   * @returns Key for the stored data
   */
  async putTemp(
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<string> {
    await this.ensureTemp()
    const key = this.genKey()
    const data = !(Symbol.asyncIterator in bytes)
      ? bytes
      : await collectAsyncIterable(bytes)
    await fs.writeFile(this.getTmpPath(key), data)
    return key
  }

  /**
   * Move temporary data to permanent storage
   *
   * @param key - Key for temporary storage
   * @param cid - Content identifier
   */
  async makePermanent(key: string, cid: Cid): Promise<void> {
    await this.ensureDir()
    const tmpPath = this.getTmpPath(key)
    const storedPath = this.getStoredPath(cid)
    const alreadyHas = await this.hasStored(cid)
    if (!alreadyHas) {
      const data = await fs.readFile(tmpPath)
      await fs.writeFile(storedPath, data)
    }
    try {
      await fs.rm(tmpPath)
    } catch (err) {
      // Log but don't fail - the blob is permanent now
      console.error('Could not delete temp file:', tmpPath, err)
    }
  }

  /**
   * Store permanent data in disk storage
   *
   * @param cid - Content identifier
   * @param bytes - Data to store
   */
  async putPermanent(
    cid: Cid,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    await this.ensureDir()
    const data = !(Symbol.asyncIterator in bytes)
      ? bytes
      : await collectAsyncIterable(bytes)
    await fs.writeFile(this.getStoredPath(cid), data)
  }

  /**
   * Quarantine a blob by moving it to the quarantine directory
   *
   * @param cid - Content identifier
   */
  async quarantine(cid: Cid): Promise<void> {
    await this.ensureQuarantine()
    const storedPath = this.getStoredPath(cid)
    const quarantinePath = this.getQuarantinePath(cid)
    try {
      await fs.rename(storedPath, quarantinePath)
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Restore a blob from quarantine to permanent storage
   *
   * @param cid - Content identifier
   */
  async unquarantine(cid: Cid): Promise<void> {
    await this.ensureDir()
    const quarantinePath = this.getQuarantinePath(cid)
    const storedPath = this.getStoredPath(cid)
    try {
      await fs.rename(quarantinePath, storedPath)
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Retrieve bytes for a blob from permanent storage
   *
   * @param cid - Content identifier
   * @returns Bytes of the blob
   */
  async getBytes(cid: Cid): Promise<Uint8Array> {
    try {
      const buffer = await fs.readFile(this.getStoredPath(cid))
      return new Uint8Array(buffer)
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        throw new BlobNotFoundError()
      }
      throw err
    }
  }

  /**
   * Retrieve a stream for a blob from permanent storage
   *
   * @param cid - Content identifier
   */
  async getStream(cid: Cid): Promise<AsyncIterable<Uint8Array>> {
    const filePath = this.getStoredPath(cid)
    const exists = await fileExists(filePath)
    if (!exists) {
      throw new BlobNotFoundError()
    }
    return readableToAsyncIterable(fsSync.createReadStream(filePath))
  }

  /**
   * Delete a blob from permanent storage
   *
   * @param cid - Content identifier
   */
  async delete(cid: Cid): Promise<void> {
    await rmIfExists(this.getStoredPath(cid))
  }

  /**
   * Delete multiple blobs from permanent storage
   *
   * @param cids - Content identifiers
   */
  async deleteMany(cids: Cid[]): Promise<void> {
    const errors: unknown[] = []
    for (const chunk of chunkArray(cids, 500)) {
      await Promise.all(
        chunk.map((cid) =>
          this.delete(cid).catch((err) => {
            errors.push(err)
          }),
        ),
      )
    }
    if (errors.length > 0) {
      throw aggregateErrors(errors)
    }
  }

  /**
   * Ensure the directory for the DID exists.
   * 1. Create the directory if it doesn't exist.
   * 2. If the directory exists, do nothing.
   '
   * @private
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.join(this.location, this.did), { recursive: true })
  }

  /**
   * Ensure the temporary directory exists.
   * 1. Create the directory if it doesn't exist.
   * 2. If the directory exists, do nothing
   *
   * @private
   */
  private async ensureTemp(): Promise<void> {
    await fs.mkdir(path.join(this.tmpLocation, this.did), { recursive: true })
  }

  /**
   * Ensure the quarantine directory exists.
   * @private
   */
  private async ensureQuarantine(): Promise<void> {
    await fs.mkdir(path.join(this.quarantineLocation, this.did), {
      recursive: true,
    })
  }

  /**
   * Generate a random key for temporary storage
   * @returns Randomly generated key
   * @private
   */
  private genKey(): string {
    return randomStr(32, 'base32')
  }
}

/**
 * Type guard for Node.js errno exceptions
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
