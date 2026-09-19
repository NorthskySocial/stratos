import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Secp256k1Keypair } from '@atproto/crypto'
import { TtlLru } from '../src/enrollment/lru.js'
import { EnrollmentManager } from '../src/enrollment/manager.js'
import { SpaceCredentialManager } from '../src/space-credential/manager.js'
import { BlobService } from '../src/blob/service.js'
import { DiskBlobCache, blobCacheKey } from '../src/blob/cache.js'
import type {
  GetBlobResult,
  GetSpaceCredentialResult,
  ResolveEnrollmentsResult,
} from '../src/upstream/client.js'

const SPIKE = 'did:plc:spike'
const FAYE = 'did:plc:faye'
const CID = 'bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa'
const BOUNDARY = 'did:web:nerv.example/pilots'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

function enrollment(boundaries: string[]): ResolveEnrollmentsResult {
  return { did: SPIKE, enrolled: true, boundaries }
}

function credential(value: string): GetSpaceCredentialResult {
  return { credential: value, expiresAt: new Date(1000).toISOString() }
}

function blob(): GetBlobResult {
  return {
    stream: Readable.from([Buffer.from('Spike')]),
    contentType: 'image/png',
    contentLength: 5,
  }
}

async function disk() {
  const directory = await mkdtemp(join(tmpdir(), 'nerv-catalog-cache-'))
  dirs.push(directory)
  const cache = await DiskBlobCache.open({
    directory,
    maxBytes: 10,
    ttlMs: 10000,
  })
  return { directory, cache }
}

async function credentials(
  getSpaceCredential: () => Promise<GetSpaceCredentialResult>,
  now = () => 0,
) {
  const client = { getSpaceCredential: vi.fn(getSpaceCredential) }
  const manager = new SpaceCredentialManager({
    client,
    signingKey: await Secp256k1Keypair.create(),
    feedgenDid: 'did:web:bebop.example',
    authorityDid: 'did:web:nerv.example',
    refreshMarginMs: 100,
    random: () => 0,
    now,
  })
  return { manager, client }
}

function blobs(cache: DiskBlobCache, getBlob = async () => blob()) {
  const upstream = { getBlob: vi.fn(getBlob) }
  const service = new BlobService({
    cache,
    upstream,
    maxBlobBytes: 10,
    maxConcurrentDownloads: 1,
  })
  return { service, upstream }
}

describe('boundary catalogue cache invalidation', () => {
  it('empties the whole LRU and restores capacity for fresh entries', () => {
    const cache = new TtlLru<string, number>({ max: 2, ttlMs: 1000 })
    cache.set(SPIKE, 1)
    cache.set(FAYE, 2)
    cache.clear()
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get(SPIKE)).toBeUndefined()
    expect(cache.get(FAYE)).toBeUndefined()
    cache.set('did:plc:rei', 3)
    expect(cache.get('did:plc:rei')).toBe(3)
    expect(cache.size).toBe(1)
  })

  it('drops every enrollment and prevents detached fetches from populating or replacing current fetches', async () => {
    const old = Promise.withResolvers<ResolveEnrollmentsResult>()
    const fresh = Promise.withResolvers<ResolveEnrollmentsResult>()
    const client = {
      resolveEnrollments: vi.fn(async () => enrollment(['crew'])),
    }
    const manager = new EnrollmentManager({ client })
    await manager.getBoundaries(SPIKE)
    await manager.getBoundaries(FAYE)
    client.resolveEnrollments.mockImplementationOnce(() => old.promise)
    const stale = manager.getBoundaries('did:plc:rei')
    manager.clear()
    expect(await manager.getBoundaries(SPIKE)).toEqual(['crew'])
    expect(await manager.getBoundaries(FAYE)).toEqual(['crew'])
    expect(client.resolveEnrollments).toHaveBeenCalledTimes(5)
    client.resolveEnrollments.mockImplementationOnce(() => fresh.promise)
    const current = manager.getBoundaries('did:plc:rei')
    old.resolve(enrollment(['retired']))
    expect(await stale).toEqual(['retired'])
    const joined = manager.getBoundaries('did:plc:rei')
    expect(client.resolveEnrollments).toHaveBeenCalledTimes(6)
    fresh.resolve(enrollment(['pilots']))
    expect(await current).toEqual(['pilots'])
    expect(await joined).toEqual(['pilots'])
    expect(await manager.getBoundaries('did:plc:rei')).toEqual(['pilots'])
    expect(client.resolveEnrollments).toHaveBeenCalledTimes(6)
  })

  it('rejects pending credential callers immediately and prevents late mints from replacing the new generation', async () => {
    const old = Promise.withResolvers<GetSpaceCredentialResult>()
    const fresh = Promise.withResolvers<GetSpaceCredentialResult>()
    const { manager, client } = await credentials(() => old.promise)
    const stale = manager.getCredential(BOUNDARY)
    const joined = manager.getCredential(BOUNDARY, new AbortController().signal)
    const rejected = Promise.all([
      expect(stale).rejects.toThrow('invalidated'),
      expect(joined).rejects.toMatchObject({ code: 'CredentialInvalidated' }),
    ])
    await vi.waitFor(() =>
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1),
    )
    manager.clear()
    await rejected
    client.getSpaceCredential.mockImplementationOnce(() => fresh.promise)
    const current = manager.getCredential(BOUNDARY)
    await vi.waitFor(() =>
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(2),
    )
    fresh.resolve(credential('rei'))
    expect((await current).credential).toBe('rei')
    old.resolve(credential('retired'))
    await new Promise((resolve) => setImmediate(resolve))
    expect((await manager.getCredential(BOUNDARY)).credential).toBe('rei')
    expect(client.getSpaceCredential).toHaveBeenCalledTimes(2)
  })

  it('does not let a detached credential mint remove the replacement single-flight entry', async () => {
    const old = Promise.withResolvers<GetSpaceCredentialResult>()
    const fresh = Promise.withResolvers<GetSpaceCredentialResult>()
    const { manager, client } = await credentials(() => old.promise)
    const stale = manager.getCredential(BOUNDARY)
    const rejected = expect(stale).rejects.toThrow('invalidated')
    await vi.waitFor(() =>
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1),
    )
    manager.clear()
    await rejected
    client.getSpaceCredential.mockImplementationOnce(() => fresh.promise)
    const current = manager.getCredential(BOUNDARY)
    await vi.waitFor(() =>
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(2),
    )
    old.resolve(credential('retired'))
    await new Promise((resolve) => setImmediate(resolve))
    const joined = manager.getCredential(BOUNDARY)
    expect(client.getSpaceCredential).toHaveBeenCalledTimes(2)
    fresh.resolve(credential('asuka'))
    expect((await current).credential).toBe('asuka')
    expect((await joined).credential).toBe('asuka')
  })

  it('discards all held credentials and never falls back to one after clearing a failed refresh', async () => {
    let now = 0
    const { manager, client } = await credentials(
      async () => credential('held'),
      () => now,
    )
    await manager.getCredential(BOUNDARY)
    await manager.getCredential('did:web:nerv.example/command')
    now = 950
    const refresh = Promise.withResolvers<GetSpaceCredentialResult>()
    client.getSpaceCredential.mockImplementationOnce(() => refresh.promise)
    const pending = manager.getCredential(BOUNDARY)
    const rejected = expect(pending).rejects.toThrow('invalidated')
    await vi.waitFor(() =>
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(3),
    )
    manager.clear()
    await rejected
    refresh.reject(new Error('NERV authority unavailable'))
    await new Promise((resolve) => setImmediate(resolve))
    now = 0
    client.getSpaceCredential.mockResolvedValue(credential('fresh'))
    expect((await manager.getCredential(BOUNDARY)).credential).toBe('fresh')
    expect(
      (await manager.getCredential('did:web:nerv.example/command')).credential,
    ).toBe('fresh')
    expect(client.getSpaceCredential).toHaveBeenCalledTimes(5)
    manager.clear()
    expect((await manager.getCredential(BOUNDARY)).credential).toBe('fresh')
    expect(client.getSpaceCredential).toHaveBeenCalledTimes(6)
  })

  it('serializes disk clearing between writes and removes only tracked files', async () => {
    const { cache, directory } = await disk()
    await writeFile(join(directory, 'operator-note'), 'keep')
    const oldKey = blobCacheKey(SPIKE, CID)
    const newKey = blobCacheKey(FAYE, CID)
    const oldPut = cache.put(oldKey, Buffer.from('Spike'))
    const clear = cache.clear()
    const newPut = cache.put(newKey, Buffer.from('Spike'))
    await Promise.all([oldPut, clear, newPut])
    expect(await cache.get(oldKey)).toBeUndefined()
    expect(await cache.get(newKey)).toEqual(Buffer.from('Spike'))
    expect((await readdir(directory)).sort()).toEqual(
      [newKey, 'operator-note'].sort(),
    )
    await cache.clear()
    await cache.put(oldKey, Buffer.alloc(10))
    expect(await cache.get(oldKey)).toEqual(Buffer.alloc(10))
    expect(await readFile(join(directory, 'operator-note'), 'utf8')).toBe(
      'keep',
    )
  })

  it('clears cached bytes and downloads them again only after disk invalidation completes', async () => {
    const { cache, directory } = await disk()
    const { service, upstream } = blobs(cache)
    await service.get(SPIKE, CID)
    expect(await readdir(directory)).toEqual([blobCacheKey(SPIKE, CID)])
    const clear = service.clear()
    const fresh = service.get(SPIKE, CID)
    await clear
    expect(await fresh).toEqual(Buffer.from('Spike'))
    expect(upstream.getBlob).toHaveBeenCalledTimes(2)
  })

  it('rejects late cached reads and does not admit their downloads', async () => {
    const { cache } = await disk()
    const read = Promise.withResolvers<Buffer | undefined>()
    vi.spyOn(cache, 'get').mockImplementationOnce(() => read.promise)
    const { service, upstream } = blobs(cache)
    const pending = service.get(SPIKE, CID)
    const rejected = expect(pending).rejects.toThrow('invalidated')
    await vi.waitFor(() => expect(cache.get).toHaveBeenCalledOnce())
    await service.clear()
    read.resolve(Buffer.from('Spike'))
    await rejected
    expect(upstream.getBlob).not.toHaveBeenCalled()
    expect(await service.get(SPIKE, CID)).toEqual(Buffer.from('Spike'))
  })

  it('detaches downloads and preserves replacement admission when an old download completes', async () => {
    const { cache } = await disk()
    const old = Promise.withResolvers<GetBlobResult>()
    const fresh = Promise.withResolvers<GetBlobResult>()
    const { service, upstream } = blobs(cache, () => old.promise)
    const pending = service.get(SPIKE, CID)
    const rejected = expect(pending).rejects.toThrow('invalidated')
    await vi.waitFor(() => expect(upstream.getBlob).toHaveBeenCalledOnce())
    await service.clear()
    upstream.getBlob.mockImplementationOnce(() => fresh.promise)
    const current = service.get(SPIKE, CID)
    await vi.waitFor(() => expect(upstream.getBlob).toHaveBeenCalledTimes(2))
    const staleBlob = blob()
    old.resolve(staleBlob)
    await rejected
    expect(staleBlob.stream.destroyed).toBe(true)
    const joined = service.get(SPIKE, CID)
    await new Promise((resolve) => setImmediate(resolve))
    expect(upstream.getBlob).toHaveBeenCalledTimes(2)
    fresh.resolve(blob())
    expect(await current).toEqual(Buffer.from('Spike'))
    expect(await joined).toEqual(Buffer.from('Spike'))
  })

  it('removes puts already admitted before clear and rejects their original callers', async () => {
    const { cache, directory } = await disk()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const put = cache.put.bind(cache)
    vi.spyOn(cache, 'put').mockImplementationOnce(async (key, bytes) => {
      const written = put(key, bytes)
      entered.resolve()
      await written
      await release.promise
    })
    const { service } = blobs(cache)
    const pending = service.get(SPIKE, CID)
    const rejected = expect(pending).rejects.toThrow('invalidated')
    await entered.promise
    await service.clear()
    expect(await readdir(directory)).toEqual([])
    release.resolve()
    await rejected
    expect(await cache.get(blobCacheKey(SPIKE, CID))).toBeUndefined()
    expect(await service.get(SPIKE, CID)).toEqual(Buffer.from('Spike'))
  })

  it.each(['next chunk', 'stream end'])(
    'rejects a stream invalidated while awaiting its %s',
    async (phase) => {
      const { cache } = await disk()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const stream = Readable.from(
        (async function* () {
          yield Buffer.from(phase === 'next chunk' ? 'Sp' : 'Spike')
          entered.resolve()
          await release.promise
          if (phase === 'next chunk') yield Buffer.from('ike')
        })(),
      )
      const { service, upstream } = blobs(cache, async () => ({
        ...blob(),
        stream,
      }))
      const put = vi.spyOn(cache, 'put')
      const pending = service.get(SPIKE, CID)
      const rejected = expect(pending).rejects.toThrow('invalidated')
      await entered.promise
      await service.clear()
      release.resolve()
      await rejected
      expect(stream.destroyed).toBe(true)
      expect(put).not.toHaveBeenCalled()
      upstream.getBlob.mockResolvedValueOnce(blob())
      expect(await service.get(SPIKE, CID)).toEqual(Buffer.from('Spike'))
    },
  )

  it('keeps reads unavailable after a failed clear until clearing succeeds', async () => {
    const { cache } = await disk()
    const { service } = blobs(cache)
    await service.get(SPIKE, CID)
    const failure = new Error('NERV cache deletion failed')
    vi.spyOn(cache, 'clear').mockRejectedValueOnce(failure)
    await expect(service.clear()).rejects.toBe(failure)
    await expect(service.get(SPIKE, CID)).rejects.toBe(failure)
    await service.clear()
    expect(await service.get(SPIKE, CID)).toEqual(Buffer.from('Spike'))
  })
})
