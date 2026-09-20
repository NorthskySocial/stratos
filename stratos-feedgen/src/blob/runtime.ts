import type { FeedgenConfig } from '../config.js'
import { DiskBlobCache, MemoryBlobCache } from './cache.js'
import { BlobService, type BlobSource } from './service.js'

export async function createBlobService(
  config: FeedgenConfig,
  upstream: BlobSource,
): Promise<BlobService> {
  const cache =
    config.storageProfile === 'encrypted-volume'
      ? await DiskBlobCache.open({
          directory: requireBlobCacheDirectory(config),
          maxBytes: config.blobCacheMaxBytes,
          ttlMs: config.blobCacheTtlMs,
        })
      : new MemoryBlobCache({
          maxBytes: config.blobCacheMaxBytes,
          ttlMs: config.blobCacheTtlMs,
        })
  return new BlobService({
    upstream,
    cache,
    maxBlobBytes: config.blobMaxBytes,
    maxConcurrentDownloads: config.blobMaxConcurrentDownloads,
  })
}

function requireBlobCacheDirectory(config: FeedgenConfig): string {
  if (!config.blobCacheDirectory) {
    throw new Error(
      'blobCacheDirectory is required for the encrypted-volume storage profile',
    )
  }
  return config.blobCacheDirectory
}
