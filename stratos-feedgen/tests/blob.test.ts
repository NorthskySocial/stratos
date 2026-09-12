import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlobService } from '../src/blob/runtime.js'
import { loadFeedgenConfig } from '../src/config.js'
import type { GetBlobResult } from '../src/upstream/client.js'
import { BlobService } from '../src/blob/service.js'
import { DiskBlobCache, blobCacheKey } from '../src/blob/cache.js'

const SPIKE = 'bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa'
const FAYE = 'bafkreicftohjg7qfzr2knf7ysksl5pyvt3xvdk4gijxsflft5ikuhqboy4'
const DID = 'did:plc:spike'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function disk(maxBytes = 100, ttlMs = 1000, now = () => Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), 'bebop-blobs-'))
  dirs.push(directory)
  return {
    directory,
    cache: await DiskBlobCache.open({ directory, maxBytes, ttlMs, now }),
  }
}
const key = (cid = SPIKE) => blobCacheKey(DID, cid)

function makeService(
  cache: DiskBlobCache,
  options: { maxBlobBytes?: number; maxConcurrentDownloads?: number } = {},
) {
  const upstream = {
    getBlob: vi.fn(
      async (): Promise<GetBlobResult> => ({
        stream: Readable.from([Buffer.from('Sp'), Buffer.from('ike')]),
        contentType: 'image/png',
        contentLength: 5,
      }),
    ),
  }
  return {
    upstream,
    service: new BlobService({
      cache,
      upstream,
      maxBlobBytes: options.maxBlobBytes ?? 10,
      maxConcurrentDownloads: options.maxConcurrentDownloads ?? 2,
    }),
  }
}

describe('private disk blob cache', () => {
  it('scopes the key to the actor and CID', () => {
    expect(key()).toMatch(/^[a-f0-9]{64}$/)
    expect(key()).not.toBe(blobCacheKey('did:plc:faye', SPIKE))
    expect(key()).not.toBe(key(FAYE))
  })
  it('keeps private files, updates values and restores entries after restart', async () => {
    const { cache, directory } = await disk()
    await cache.put(key(), Buffer.from('Spike'))
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, key()))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(directory, key()), 'utf8')).toBe('Spike')
    await cache.put(key(), Buffer.from('Faye'))
    const restarted = await DiskBlobCache.open({
      directory,
      maxBytes: 100,
      ttlMs: 1000,
    })
    expect(await restarted.get(key())).toEqual(Buffer.from('Faye'))
    await restarted.remove(key())
    expect(await restarted.get(key())).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
    await restarted.remove(key())
  })
  it('evicts the least recently read entry and enforces exact total capacity', async () => {
    const { cache } = await disk(9)
    await cache.put(key(), Buffer.from('Spike'))
    await cache.put(key(FAYE), Buffer.from('Faye'))
    expect(await cache.get(key())).toEqual(Buffer.from('Spike'))
    await cache.put(blobCacheKey('did:plc:jet', SPIKE), Buffer.from('Jet'))
    expect(await cache.get(key(FAYE))).toBeUndefined()
    expect(await cache.get(key())).toEqual(Buffer.from('Spike'))
    await cache.put(key(FAYE), Buffer.alloc(10))
    expect(await cache.get(key(FAYE))).toBeUndefined()
    expect(await cache.get(key())).toEqual(Buffer.from('Spike'))
  })
  it('expires entries at the deadline and does not extend retention on reads', async () => {
    let now = 1000
    const { cache, directory } = await disk(100, 100, () => now)
    await cache.put(key(), Buffer.from('Spike'))
    now = 1099
    expect(await cache.get(key())).toEqual(Buffer.from('Spike'))
    now = 1100
    expect(await cache.get(key())).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
  })
  it('removes expired and oversized cache files at startup and bounds restored entries', async () => {
    const { cache, directory } = await disk()
    await cache.put(key(), Buffer.from('Spike'))
    await utimes(join(directory, key()), 1, 1)
    await cache.put(key(FAYE), Buffer.alloc(20))
    await writeFile(join(directory, 'operator-note'), 'keep')
    await DiskBlobCache.open({ directory, maxBytes: 10, ttlMs: 1000 })
    expect(await readdir(directory)).toEqual(['operator-note'])
    await cache.put(key(), Buffer.from('Spike'))
    await cache.put(key(FAYE), Buffer.from('Faye'))
    const restored = await DiskBlobCache.open({
      directory,
      maxBytes: 5,
      ttlMs: 1000,
    })
    const values = await Promise.all([
      restored.get(key()),
      restored.get(key(FAYE)),
    ])
    expect(values.filter(Boolean)).toHaveLength(1)
  })
  it('treats a removed file as a miss and recovers the byte budget', async () => {
    const { cache, directory } = await disk(5)
    await cache.put(key(), Buffer.from('Spike'))
    await rm(join(directory, key()))
    expect(await cache.get(key())).toBeUndefined()
    await cache.put(key(FAYE), Buffer.from('Faye'))
    expect(await cache.get(key(FAYE))).toEqual(Buffer.from('Faye'))
  })
})

describe('verified blob downloads', () => {
  it('fetches once then verifies cache hits and isolates actors', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache)
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(upstream.getBlob).toHaveBeenCalledExactlyOnceWith(DID, SPIKE)
    expect(await service.get('did:plc:faye', SPIKE)).toEqual(
      Buffer.from('Spike'),
    )
    expect(upstream.getBlob).toHaveBeenCalledTimes(2)
  })
  it('rejects corrupt upstream bytes and retries subsequent requests', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache)
    await expect(service.get(DID, FAYE)).rejects.toThrow(
      'Blob content does not match its CID',
    )
    expect(await cache.get(key(FAYE))).toBeUndefined()
    upstream.getBlob.mockResolvedValue({
      stream: Readable.from([Buffer.from('Faye')]),
      contentType: 'image/png',
      contentLength: 4,
    })
    expect(await service.get(DID, FAYE)).toEqual(Buffer.from('Faye'))
  })
  it('removes corrupt and oversized cache entries before fetching', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache)
    await cache.put(key(), Buffer.from('Faye'))
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    await cache.put(key(), Buffer.alloc(11))
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(upstream.getBlob).toHaveBeenCalledTimes(2)
  })
  it('accepts exactly the object limit', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache, { maxBlobBytes: 5 })
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(upstream.getBlob).toHaveBeenCalledOnce()
  })
  it.each([true, false])(
    'caps downloads with or without a truthful length header (%s)',
    async (knownLength) => {
      const { cache } = await disk()
      const { service, upstream } = makeService(cache, { maxBlobBytes: 4 })
      const stream = Readable.from([Buffer.from('Sp'), Buffer.from('ike')])
      upstream.getBlob.mockResolvedValue({
        stream,
        contentType: 'image/png',
        contentLength: knownLength ? 5 : 0,
      })
      await expect(service.get(DID, SPIKE)).rejects.toMatchObject({
        message: 'Blob exceeds the download limit',
        customErrorName: 'BlobTooLarge',
      })
      expect(stream.destroyed).toBe(true)
      expect(await cache.get(key())).toBeUndefined()
    },
  )
  it('deduplicates concurrent misses, bounds parallel downloads and releases slots on failure', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache, {
      maxConcurrentDownloads: 1,
    })
    let release!: () => void
    upstream.getBlob.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        stream: Readable.from([Buffer.from('Spike')]),
        contentType: 'image/png',
        contentLength: 5,
      }
    })
    const first = service.get(DID, SPIKE)
    await vi.waitFor(() => expect(upstream.getBlob).toHaveBeenCalledTimes(1))
    const same = service.get(DID, SPIKE)
    await expect(service.get('did:plc:faye', SPIKE)).rejects.toMatchObject({
      message: 'Blob downloads are busy',
      customErrorName: 'BlobBusy',
    })
    release()
    expect(await first).toEqual(Buffer.from('Spike'))
    expect(await same).toEqual(Buffer.from('Spike'))
    expect(upstream.getBlob).toHaveBeenCalledTimes(1)
    upstream.getBlob.mockRejectedValueOnce(new Error('upstream offline'))
    await expect(service.get(DID, FAYE)).rejects.toThrow('upstream offline')
    upstream.getBlob.mockResolvedValue({
      stream: Readable.from([Buffer.from('Faye')]),
      contentType: 'image/png',
      contentLength: 4,
    })
    expect(await service.get(DID, FAYE)).toEqual(Buffer.from('Faye'))
  })
})

describe('blob runtime configuration', () => {
  it('wires cache location and limits into the running service', async () => {
    const { directory } = await disk()
    const config = loadFeedgenConfig({
      FEEDGEN_SERVICE_DID: 'did:web:bebop.test',
      FEEDGEN_SIGNING_KEY: 'unused',
      STRATOS_SERVICE_URL: 'https://nerve.test',
      STRATOS_SERVICE_DID: 'did:web:nerve.test',
      FEEDGEN_MEMBERSHIP_SQLITE_PATH: '/tmp/nerve-membership',
      FEEDGEN_BLOB_CACHE_DIRECTORY: directory,
      FEEDGEN_BLOB_CACHE_MAX_BYTES: '5',
      FEEDGEN_BLOB_CACHE_TTL_MS: '1',
      FEEDGEN_BLOB_MAX_BYTES: '5',
      FEEDGEN_BLOB_MAX_CONCURRENT_DOWNLOADS: '1',
    })
    const upstream = {
      getBlob: vi.fn(async () => ({
        stream: Readable.from([Buffer.from('Spike')]),
        contentType: 'image/png',
        contentLength: 5,
      })),
    }
    const service = await createBlobService(config, upstream)
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(await readFile(join(directory, key()), 'utf8')).toBe('Spike')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
    expect(upstream.getBlob).toHaveBeenCalledTimes(2)
    upstream.getBlob.mockResolvedValue({
      stream: Readable.from([Buffer.from('123456')]),
      contentType: 'image/png',
      contentLength: 6,
    })
    await expect(service.get(DID, FAYE)).rejects.toThrow(
      'Blob exceeds the download limit',
    )
  })
  it('cleans interrupted writes and refuses cached symbolic links', async () => {
    const { directory } = await disk()
    await writeFile(join(directory, `${key()}.tmp`), 'partial')
    await writeFile(join(directory, 'private-source'), 'private')
    await symlink(join(directory, 'private-source'), join(directory, key(FAYE)))
    const cache = await DiskBlobCache.open({
      directory,
      maxBytes: 100,
      ttlMs: 1000,
    })
    expect(await readdir(directory)).toEqual(['private-source'])
    expect(await cache.get(key(FAYE))).toBeUndefined()
    expect(await readFile(join(directory, 'private-source'), 'utf8')).toBe(
      'private',
    )
  })
})

describe('cache edge conditions', () => {
  it('does not re-admit an untracked file after a cache entry disappears', async () => {
    const { cache, directory } = await disk()
    await cache.put(key(), Buffer.from('Spike'))
    await rm(join(directory, key()))
    expect(await cache.get(key())).toBeUndefined()
    await writeFile(join(directory, key()), 'Faye')
    expect(await cache.get(key())).toBeUndefined()
  })
  it('propagates a cache read error and releases the operation queue', async () => {
    const { cache, directory } = await disk()
    await cache.put(key(), Buffer.from('Spike'))
    await rm(join(directory, key()))
    await mkdir(join(directory, key()))
    await expect(cache.get(key())).rejects.toMatchObject({ code: 'EISDIR' })
    await cache.put(key(FAYE), Buffer.from('Faye'))
    expect(await cache.get(key(FAYE))).toEqual(Buffer.from('Faye'))
  })
  it('only cleans exact cache file names and expires at the startup deadline', async () => {
    const { cache, directory } = await disk()
    const names = [`x${key()}`, `${key()}x`, `x${key()}.tmp`, `${key()}.tmpx`]
    for (const name of names) {
      await writeFile(join(directory, name), 'keep')
      await utimes(join(directory, name), 0, 0)
    }
    await cache.put(key(), Buffer.from('Spike'))
    await utimes(join(directory, key()), 1, 1)
    await DiskBlobCache.open({
      directory,
      maxBytes: 100,
      ttlMs: 1000,
      now: () => 2000,
    })
    expect((await readdir(directory)).sort()).toEqual(names.sort())
  })
  it('refuses a valid cached blob larger than a newly configured limit', async () => {
    const { cache } = await disk()
    await cache.put(key(), Buffer.from('Spike'))
    const { service, upstream } = makeService(cache, { maxBlobBytes: 4 })
    await expect(service.get(DID, SPIKE)).rejects.toMatchObject({
      customErrorName: 'BlobTooLarge',
    })
    expect(upstream.getBlob).toHaveBeenCalledOnce()
    expect(await cache.get(key())).toBeUndefined()
  })
  it('rejects an oversized declared length without reading the body', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache, { maxBlobBytes: 5 })
    const stream = Readable.from([Buffer.from('Spike')])
    const iterator = vi.spyOn(stream, Symbol.asyncIterator)
    upstream.getBlob.mockResolvedValue({
      stream,
      contentType: 'image/png',
      contentLength: 6,
    })
    await expect(service.get(DID, SPIKE)).rejects.toMatchObject({
      customErrorName: 'BlobTooLarge',
    })
    expect(iterator).not.toHaveBeenCalled()
    expect(stream.destroyed).toBe(true)
  })
  it('accepts a bounded body without a content-length header', async () => {
    const { cache } = await disk()
    const { service, upstream } = makeService(cache)
    upstream.getBlob.mockResolvedValue({
      stream: Readable.from([Buffer.from('Spike')]),
      contentType: 'image/png',
    })
    expect(await service.get(DID, SPIKE)).toEqual(Buffer.from('Spike'))
  })
  it.each([
    'bafyreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa',
    'bafkrgidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa',
  ])('rejects an unsupported CID codec or hash: %s', async (cid) => {
    const { cache } = await disk()
    const { service } = makeService(cache)
    await expect(service.get(DID, cid)).rejects.toThrow(
      'Blob content does not match its CID',
    )
    expect(await cache.get(key(cid))).toBeUndefined()
  })
})
