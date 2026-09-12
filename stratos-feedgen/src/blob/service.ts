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
  constructor(private readonly options: BlobServiceOptions) {}

  async get(did: string, cid: string): Promise<Buffer> {
    const key = blobCacheKey(did, cid)
    const cached = await this.options.cache.get(key)
    if (cached !== undefined) {
      if (cached.length <= this.options.maxBlobBytes && matchesCid(cached, cid))
        return cached
      await this.options.cache.remove(key)
    }
    const existing = this.downloads.get(key)
    if (existing) return existing
    if (this.downloads.size >= this.options.maxConcurrentDownloads) {
      throw new NotEnoughResourcesError('Blob downloads are busy', 'BlobBusy')
    }
    const download = this.download(did, cid, key)
    this.downloads.set(key, download)
    try {
      return await download
    } finally {
      this.downloads.delete(key)
    }
  }

  private async download(
    did: string,
    cid: string,
    key: string,
  ): Promise<Buffer> {
    const result = await this.options.upstream.getBlob(did, cid)
    const chunks: Buffer[] = []
    let length = 0
    try {
      if ((result.contentLength ?? 0) > this.options.maxBlobBytes) {
        throw new InvalidRequestError(
          'Blob exceeds the download limit',
          'BlobTooLarge',
        )
      }
      for await (const chunk of result.stream) {
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
    await this.options.cache.put(key, bytes)
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
