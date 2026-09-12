import { createHash } from 'node:crypto'
import {
  InvalidRequestError,
  NotEnoughResourcesError,
  UpstreamFailureError,
} from '@atproto/xrpc-server'
import { parseCid } from '@northskysocial/stratos-core'
import type { GetBlobResult } from '../upstream/client.js'
import { blobCacheKey, type BlobCache } from './cache.js'

export interface BlobSource {
  getBlob: (did: string, cid: string) => Promise<GetBlobResult>
}

export interface BlobServiceOptions {
  cache: BlobCache
  upstream: BlobSource
  maxBlobBytes: number
  maxConcurrentDownloads: number
}

export class BlobService {
  private readonly downloads = new Map<string, Promise<Buffer>>()
  private generation = Symbol()
  private clearing = Promise.resolve()
  constructor(private readonly options: BlobServiceOptions) {}

  async get(did: string, cid: string): Promise<Buffer> {
    const generation = this.generation
    await this.clearing
    this.assertCurrent(generation)
    const key = blobCacheKey(did, cid)
    const cached = await this.options.cache.get(key)
    this.assertCurrent(generation)
    if (cached !== undefined) {
      if (cached.length <= this.options.maxBlobBytes && matchesCid(cached, cid))
        return cached
      await this.options.cache.remove(key)
      this.assertCurrent(generation)
    }
    const existing = this.downloads.get(key)
    if (existing) return existing
    if (this.downloads.size >= this.options.maxConcurrentDownloads) {
      throw new NotEnoughResourcesError('Blob downloads are busy', 'BlobBusy')
    }
    const download = this.download(did, cid, key, generation)
    this.downloads.set(key, download)
    try {
      return await download
    } finally {
      if (this.downloads.get(key) === download) this.downloads.delete(key)
    }
  }

  clear(): Promise<void> {
    this.generation = Symbol()
    this.downloads.clear()
    this.clearing = this.options.cache.clear()
    return this.clearing
  }

  private assertCurrent(generation: symbol): void {
    if (generation !== this.generation)
      throw new UpstreamFailureError('Blob cache was invalidated')
  }

  private async download(
    did: string,
    cid: string,
    key: string,
    generation: symbol,
  ): Promise<Buffer> {
    const result = await this.options.upstream.getBlob(did, cid)
    const chunks: Buffer[] = []
    let length = 0
    try {
      this.assertCurrent(generation)
      if ((result.contentLength ?? 0) > this.options.maxBlobBytes) {
        throw new InvalidRequestError(
          'Blob exceeds the download limit',
          'BlobTooLarge',
        )
      }
      for await (const chunk of result.stream) {
        this.assertCurrent(generation)
        const bytes = Buffer.from(chunk as Uint8Array)
        length += bytes.length
        if (length > this.options.maxBlobBytes) {
          throw new InvalidRequestError(
            'Blob exceeds the download limit',
            'BlobTooLarge',
          )
        }
        chunks.push(bytes)
      }
    } finally {
      result.stream.destroy()
    }
    const bytes = Buffer.concat(chunks)
    if (!matchesCid(bytes, cid))
      throw new UpstreamFailureError('Blob content does not match its CID')
    this.assertCurrent(generation)
    await this.options.cache.put(key, bytes)
    this.assertCurrent(generation)
    return bytes
  }
}

function matchesCid(bytes: Buffer, cid: string): boolean {
  const parsed = parseCid(cid)
  return (
    parsed.code === 0x55 &&
    parsed.multihash.code === 0x12 &&
    Buffer.from(parsed.multihash.digest).equals(
      createHash('sha256').update(bytes).digest(),
    )
  )
}
