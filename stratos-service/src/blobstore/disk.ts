import fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { CID } from 'multiformats/cid'
import {
  fileExists,
  rmIfExists,
  chunkArray,
  aggregateErrors,
} from '@atproto/common'
import { randomStr } from '@atproto/crypto'
import {
  type BlobStore,
  type BlobStoreCreator,
  BlobNotFoundError,
} from '@northskysocial/stratos-core'
import { readableToAsyncIterable, collectAsyncIterable } from './util.js'

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

  getTmpPath(key: string): string {
    return path.join(this.tmpLocation, this.did, key)
  }

  getStoredPath(cid: CID): string {
    return path.join(this.location, this.did, cid.toString())
  }

  getQuarantinePath(cid: CID): string {
    return path.join(this.quarantineLocation, this.did, cid.toString())
  }

  async hasTemp(key: string): Promise<boolean> {
    return fileExists(this.getTmpPath(key))
  }

  async hasStored(cid: CID): Promise<boolean> {
    return fileExists(this.getStoredPath(cid))
  }

  async putTemp(
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<string> {
    await this.ensureTemp()
    const key = this.genKey()
    const data =
      bytes instanceof Uint8Array ? bytes : await collectAsyncIterable(bytes)
    await fs.writeFile(this.getTmpPath(key), data)
    return key
  }

  async makePermanent(key: string, cid: CID): Promise<void> {
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

  async putPermanent(
    cid: CID,
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    await this.ensureDir()
    const data =
      bytes instanceof Uint8Array ? bytes : await collectAsyncIterable(bytes)
    await fs.writeFile(this.getStoredPath(cid), data)
  }

  async quarantine(cid: CID): Promise<void> {
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

  async unquarantine(cid: CID): Promise<void> {
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

  async getBytes(cid: CID): Promise<Uint8Array> {
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

  async getStream(cid: CID): Promise<AsyncIterable<Uint8Array>> {
    const filePath = this.getStoredPath(cid)
    const exists = await fileExists(filePath)
    if (!exists) {
      throw new BlobNotFoundError()
    }
    return readableToAsyncIterable(fsSync.createReadStream(filePath))
  }

  async delete(cid: CID): Promise<void> {
    await rmIfExists(this.getStoredPath(cid))
  }

  async deleteMany(cids: CID[]): Promise<void> {
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

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.join(this.location, this.did), { recursive: true })
  }

  private async ensureTemp(): Promise<void> {
    await fs.mkdir(path.join(this.tmpLocation, this.did), { recursive: true })
  }

  private async ensureQuarantine(): Promise<void> {
    await fs.mkdir(path.join(this.quarantineLocation, this.did), {
      recursive: true,
    })
  }

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
