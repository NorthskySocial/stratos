import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { AuthRequiredError } from '@atproto/xrpc-server'
import { createFeedgenServer } from '../src/server.js'
import { BoundaryCatalog } from '../src/feeds/catalog.js'
import type { CatalogBoundary } from '../src/feeds/catalog-model.js'
import { EnrollmentManager } from '../src/enrollment/manager.js'
import { BlobService } from '../src/blob/service.js'
import { DiskBlobCache, blobCacheKey } from '../src/blob/cache.js'
import type {
  FeedgenStore,
  IndexedPost,
  ListPostsOpts,
} from '../src/db/index.js'
import type { GetBlobResult } from '../src/upstream/client.js'

const AUTHORITY = 'did:web:nerv.example'
const VIEWER = 'did:plc:spike'
const AUTHOR = 'did:plc:faye'
const CID = 'bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function boundary(
  roomId: string,
  changes: Partial<CatalogBoundary> = {},
): CatalogBoundary {
  return {
    boundary: `${AUTHORITY}/${roomId}`,
    roomId,
    displayName: `NERV ${roomId}`,
    description: `The ${roomId} crew`,
    listed: true,
    joinable: true,
    revision: 1,
    ...changes,
  }
}

function post(entry: CatalogBoundary): IndexedPost {
  return {
    uri: `at://${AUTHOR}/zone.stratos.feed.post/${entry.roomId}`,
    did: AUTHOR,
    cid: CID,
    sortAt: '1998-01-01T00:00:00.000Z',
    indexedAt: '1998-01-01T00:00:00.000Z',
    record: {
      $type: 'zone.stratos.feed.post',
      text: `Faye visits ${entry.roomId}`,
    },
    blobRefs: [{ cid: CID, mimeType: 'image/png' }],
    boundaries: [entry.boundary],
  }
}

function blob(): GetBlobResult {
  return {
    stream: Readable.from([Buffer.from('Spike')]),
    contentType: 'image/png',
    contentLength: 5,
  }
}

async function setup(initial = [boundary('bebop')]) {
  let rows = initial
  const records = new Map(
    initial.map((entry) => [post(entry).uri, post(entry)]),
  )
  const configuredBoundaries = new Set<string>()
  const listBoundaries = vi.fn(async () => rows)
  const catalog = new BoundaryCatalog({
    client: { listBoundaries },
    configuredBoundaries,
    options: {
      mode: 'upstream',
      refreshMs: 60000,
      maxAgeMs: 120000,
      requestTimeoutMs: 1000,
      applyTimeoutMs: 10000,
    },
    apply: async (_previous, next) => {
      // Retain projections and caches to test the HTTP scope gate independently.
      configuredBoundaries.clear()
      for (const entry of next) configuredBoundaries.add(entry.boundary)
    },
    suspend: async () => {},
    onError: vi.fn(),
  })
  await catalog.start()
  expect(catalog.isReady()).toBe(true)
  const resolveEnrollments = vi.fn(async () => ({
    did: VIEWER,
    enrolled: true,
    boundaries: ['bebop', 'pilots', 'command'].map(
      (room) => `${AUTHORITY}/${room}`,
    ),
  }))
  const enrollmentManager = new EnrollmentManager({
    client: { resolveEnrollments },
  })
  const directory = await mkdtemp(join(tmpdir(), 'nerv-catalog-http-'))
  const cache = await DiskBlobCache.open({
    directory,
    maxBytes: 100,
    ttlMs: 120000,
  })
  const upstreamBlob = vi.fn(async () => blob())
  const blobs = new BlobService({
    cache,
    upstream: { getBlob: upstreamBlob },
    maxBlobBytes: 100,
    maxConcurrentDownloads: 2,
  })
  const getBlob = vi.spyOn(blobs, 'get')
  const getPost = vi.fn(async (uri: string) => records.get(uri) ?? null)
  const listPostsByBoundary = vi.fn(async ({ boundary }: ListPostsOpts) => ({
    posts: [...records.values()].filter((value) =>
      value.boundaries.includes(boundary),
    ),
  }))
  const resolveHandle = vi.fn(
    async (_did: string): Promise<string | undefined> => 'faye.example',
  )
  const server = createFeedgenServer({
    feedgenServiceDid: 'did:web:bebop.example',
    feedgenPublicUrl: 'https://bebop.example',
    publicKeyMultibase: 'zFake',
    feeds: catalog,
    feedReadiness: catalog,
    configuredBoundaries,
    store: {
      getPost,
      listPostsByBoundary,
      listSpaceMembers: async () => [],
    } as unknown as FeedgenStore,
    enrollmentManager,
    blobs,
    resolveHandle,
    verifier: async ({ headers }) => {
      if (!headers.authorization) throw new AuthRequiredError('missing token')
      return {
        viewerDid: VIEWER,
        lxm:
          headers.authorization === 'Bearer feed'
            ? 'zone.stratos.feedgen.getFeed'
            : 'zone.stratos.feedgen.getBlob',
      }
    },
  })
  const http = await server.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  cleanups.push(async () => {
    await catalog.stop()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  const request = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(5000),
    })
  return {
    catalog,
    cache,
    records,
    listBoundaries,
    configuredBoundaries,
    enrollmentManager,
    resolveEnrollments,
    listPostsByBoundary,
    resolveHandle,
    upstreamBlob,
    getBlob,
    describe: () => request('/xrpc/zone.stratos.feedgen.describeFeed'),
    feed: (id = 'bebop') =>
      request(`/xrpc/zone.stratos.feedgen.getFeed?feed=${id}`, 'feed'),
    blob: (id = 'bebop') =>
      request(
        `/xrpc/zone.stratos.feedgen.getBlob?${new URLSearchParams({ uri: post(boundary(id)).uri, cid: CID })}`,
        'blob',
      ),
    health: () => request('/health'),
    replace: async (next: CatalogBoundary[]) => {
      rows = next
      for (const entry of next) {
        const value = post(entry)
        if (!records.has(value.uri)) records.set(value.uri, value)
      }
      await catalog.refresh()
    },
  }
}

describe('authority boundary catalogue over feedgen HTTP', () => {
  it('hides unlisted feeds while preserving member access to unlisted and closed-to-join boundaries', async () => {
    const ctx = await setup([
      boundary('bebop', { listed: false }),
      boundary('command', { joinable: false }),
    ])
    const description = await ctx.describe()
    expect(description.status).toBe(200)
    expect(await description.json()).toMatchObject({
      feeds: [{ id: 'command', boundary: `${AUTHORITY}/command` }],
    })
    expect((await ctx.feed('bebop')).status).toBe(200)
    expect((await ctx.feed('command')).status).toBe(200)
    expect((await ctx.blob('bebop')).status).toBe(200)
    ctx.resolveEnrollments.mockResolvedValue({
      did: VIEWER,
      enrolled: true,
      boundaries: [],
    })
    ctx.enrollmentManager.clear()
    const denied = await ctx.feed('bebop')
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: 'BoundaryMismatch' })
  })

  it('adds, revises and removes the feeds returned by both public description and member reads', async () => {
    const ctx = await setup()
    expect((await ctx.feed('pilots')).status).toBe(400)
    await ctx.replace([
      boundary('bebop', {
        revision: 2,
        displayName: 'Cowboy Crew',
        description: 'A revised room',
        joinable: false,
      }),
      boundary('pilots'),
    ])
    expect(ctx.catalog.isReady()).toBe(true)
    expect(await (await ctx.describe()).json()).toMatchObject({
      feeds: [
        {
          id: 'bebop',
          displayName: 'Cowboy Crew',
          description: 'A revised room',
        },
        { id: 'pilots', boundary: `${AUTHORITY}/pilots` },
      ],
    })
    const added = await ctx.feed('pilots')
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({
      feed: [{ post: { boundaries: [`${AUTHORITY}/pilots`] } }],
    })
    expect((await ctx.feed('bebop')).status).toBe(200)
    await ctx.replace([boundary('pilots')])
    expect(await (await ctx.describe()).json()).toMatchObject({
      feeds: [{ id: 'pilots' }],
    })
    const removed = await ctx.feed('bebop')
    expect(removed.status).toBe(400)
    expect(await removed.json()).toMatchObject({ error: 'UnknownFeed' })
  })

  it('returns unavailable feed, blob and health responses when authority refresh fails, then recovers', async () => {
    const ctx = await setup()
    expect((await ctx.health()).status).toBe(200)
    expect((await ctx.feed()).status).toBe(200)
    expect((await ctx.blob()).status).toBe(200)
    ctx.listBoundaries.mockRejectedValueOnce(
      new Error('NERV authority unavailable'),
    )
    await ctx.catalog.refresh()
    const health = await ctx.health()
    expect(health.status).toBe(503)
    expect(await health.json()).toMatchObject({ ok: false, feedReady: false })
    for (const response of await Promise.all([ctx.feed(), ctx.blob()])) {
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: 'FeedNotReady' })
    }
    expect(await (await ctx.describe()).json()).toMatchObject({ feeds: [] })
    expect(ctx.getBlob).toHaveBeenCalledTimes(1)
    await ctx.catalog.refresh()
    expect((await ctx.health()).status).toBe(200)
    expect((await ctx.feed()).status).toBe(200)
    expect((await ctx.blob()).status).toBe(200)
  })

  it('denies a removed blob scope even with retained projections, bytes and stale viewer membership', async () => {
    const ctx = await setup([boundary('bebop'), boundary('command')])
    const first = await ctx.blob()
    expect(first.status).toBe(200)
    expect(await first.text()).toBe('Spike')
    await ctx.replace([boundary('command')])
    expect(ctx.catalog.isReady()).toBe(true)
    expect(ctx.records.has(post(boundary('bebop')).uri)).toBe(true)
    expect(await ctx.cache.get(blobCacheKey(AUTHOR, CID))).toEqual(
      Buffer.from('Spike'),
    )
    expect(await ctx.enrollmentManager.getBoundaries(VIEWER)).toContain(
      `${AUTHORITY}/bebop`,
    )
    const denied = await ctx.blob()
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: 'BlobNotFound' })
    expect(ctx.getBlob).toHaveBeenCalledTimes(1)
    expect(ctx.upstreamBlob).toHaveBeenCalledTimes(1)
    expect(ctx.resolveEnrollments).toHaveBeenCalledTimes(1)
    expect((await ctx.blob('command')).status).toBe(200)
  })

  it.each(['query', 'author handles'])(
    'rejects an in-flight feed whose registry entry changes while awaiting %s',
    async (phase) => {
      const ctx = await setup()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      if (phase === 'query') {
        ctx.listPostsByBoundary.mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
          return { posts: [post(boundary('bebop'))] }
        })
      } else {
        ctx.resolveHandle.mockImplementationOnce(async () => {
          entered.resolve()
          await release.promise
          return 'faye.example'
        })
      }
      const pending = ctx.feed()
      try {
        await entered.promise
        const original = ctx.catalog.get('bebop')
        await ctx.replace([
          boundary('bebop', { revision: 2, displayName: 'Cowboy Crew' }),
        ])
        expect(ctx.catalog.isReady()).toBe(true)
        expect(ctx.catalog.get('bebop')).not.toBe(original)
        release.resolve()
        const response = await pending
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({
          error: 'FeedNotReady',
          message: 'Feed catalogue changed during the request',
        })
        expect((await ctx.feed()).status).toBe(200)
      } finally {
        release.resolve()
      }
    },
  )

  it('rechecks the configured scope after a blob download crosses a catalogue removal', async () => {
    const ctx = await setup([boundary('bebop'), boundary('command')])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<GetBlobResult>()
    ctx.upstreamBlob.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    const pending = ctx.blob()
    try {
      await entered.promise
      await ctx.replace([boundary('command')])
      release.resolve(blob())
      const response = await pending
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'BlobNotFound' })
    } finally {
      release.resolve(blob())
    }
  })
})
