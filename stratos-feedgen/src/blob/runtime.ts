import type { FeedgenConfig } from '../config.js'
import { DiskBlobCache } from './cache.js'
import { BlobService, type BlobSource } from './service.js'

export async function createBlobService(
  config: FeedgenConfig,
  upstream: BlobSource,
): Promise<BlobService> {
  return new BlobService({
    upstream,
    cache: await DiskBlobCache.open({
      directory: config.blobCacheDirectory,
      maxBytes: config.blobCacheMaxBytes,
      ttlMs: config.blobCacheTtlMs,
    }),
    maxBlobBytes: config.blobMaxBytes,
    maxConcurrentDownloads: config.blobMaxConcurrentDownloads,
  })
}
