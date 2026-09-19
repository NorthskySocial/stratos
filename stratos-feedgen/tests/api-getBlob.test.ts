import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthRequiredError } from '@atproto/xrpc-server'
import { createFeedgenServer } from '../src/server.js'
import { buildFeedRegistry } from '../src/feeds/index.js'
import type {
  FeedgenStore,
  IndexedPost,
  SpaceMemberSnapshot,
} from '../src/db/index.js'
import type { EnrollmentManager } from '../src/enrollment/index.js'
import type { BlobService } from '../src/blob/service.js'
import { SpaceMutationFence } from '../src/mutation-fence.js'

const CID = 'bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa'
const AUTHOR = 'did:plc:faye'
const VIEWER = 'did:plc:spike'
const URI = `at://${AUTHOR}/zone.stratos.feed.post/one`
const SPACE_URI = `at://did:web:nerve.test/space/zone.stratos.space.feed/engineering/${AUTHOR}/zone.stratos.feed.post/one`
const headers = { authorization: 'Bearer bebop' }
const servers: HttpServer[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  )
})
function post(uri = URI): IndexedPost {
  return {
    uri,
    did: AUTHOR,
    cid: CID,
    sortAt: '1998-01-01T00:00:00.000Z',
    indexedAt: '1998-01-01T00:00:00.000Z',
    record: {
      $type: 'zone.stratos.feed.post',
      text: 'Faye',
      embed: {
        image: {
          $type: 'blob',
          ref: { $link: CID },
          mimeType: 'image/png',
          size: 5,
        },
      },
    },
    blobRefs: [{ cid: CID, mimeType: 'image/png' }],
    boundaries: ['engineering'],
  }
}
async function setup(
  options: {
    post?: IndexedPost
    members?: SpaceMemberSnapshot[]
    boundaries?: string[]
    ready?: boolean
    lxm?: string
    omitGates?: boolean
  } = {},
) {
  const value = options.post ?? post()
  const getPost = vi.fn(
    async (_uri: string): Promise<IndexedPost | null> => value,
  )
  const getBoundaries = vi.fn(async () => options.boundaries ?? ['engineering'])
  const listSpaceMembers = vi.fn(async () => options.members ?? [])
  const get = vi.fn(async () => Buffer.from('Spike'))
  const readiness = { isReady: vi.fn(() => options.ready ?? true) }
  const mutationFence = new SpaceMutationFence()
  const server = createFeedgenServer({
    feedgenServiceDid: 'did:web:feedgen.test',
    feedgenPublicUrl: 'https://feedgen.test',
    publicKeyMultibase: 'zFake',
    feeds: buildFeedRegistry([{ id: 'bebop', boundary: 'engineering' }]),
    store: {
      getPost,
      listSpaceMembers,
      listPostsByBoundary: async () => ({ posts: [value] }),
    } as unknown as FeedgenStore,
    enrollmentManager: { getBoundaries } as unknown as EnrollmentManager,
    blobs: { get } as unknown as BlobService,
    verifier: async ({ headers }) => {
      if (!headers.authorization) throw new AuthRequiredError('missing token')
      return {
        viewerDid: VIEWER,
        lxm: options.lxm ?? 'zone.stratos.feedgen.getBlob',
      }
    },
    feedReadiness: options.omitGates ? undefined : readiness,
    mutationFence: options.omitGates ? undefined : mutationFence,
  })
  const http = await server.listen(0, '127.0.0.1')
  servers.push(http)
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const url = `${base}/xrpc/zone.stratos.feedgen.getBlob?${new URLSearchParams({ uri: value.uri, cid: CID })}`
  return {
    url,
    base,
    get,
    getPost,
    getBoundaries,
    listSpaceMembers,
    readiness,
    mutationFence,
    value,
  }
}

describe('authenticated feedgen blob XRPC', () => {
  it('authorizes and returns private bytes with safe response headers', async () => {
    const ctx = await setup()
    const response = await fetch(ctx.url, { headers })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('Spike')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Authorization')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox",
    )
    expect(ctx.get).toHaveBeenCalledExactlyOnceWith(AUTHOR, CID)
    expect(ctx.getBoundaries).toHaveBeenCalledTimes(2)
    expect(ctx.getPost).toHaveBeenCalledTimes(2)
  })
  it.each([
    'image/svg+xml',
    'text/html',
    'IMAGE/PNG',
    'image/png; charset=utf-8',
    undefined,
  ])('does not serve active or unknown MIME %s inline', async (mimeType) => {
    const value = post()
    value.blobRefs = [{ cid: CID, mimeType }]
    const ctx = await setup({ post: value })
    const response = await fetch(ctx.url, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    )
  })
  it.each([
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
  ])('allows passive media %s', async (mimeType) => {
    const value = post()
    value.blobRefs = [{ cid: CID, mimeType }]
    const ctx = await setup({ post: value })
    const response = await fetch(ctx.url, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mimeType)
  })
  it('requires authentication scoped to getBlob', async () => {
    const ctx = await setup({ lxm: 'zone.stratos.feedgen.getFeed' })
    expect((await fetch(ctx.url)).status).toBe(401)
    const response = await fetch(ctx.url, { headers })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: 'BadJwtLexiconMethod',
      message: 'JWT does not authorize this method',
    })
    expect(ctx.get).not.toHaveBeenCalled()
  })
  it('does not accept a blob token for getFeed', async () => {
    const ctx = await setup()
    const response = await fetch(
      `${ctx.base}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop`,
      { headers },
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: 'BadJwtLexiconMethod',
      message: 'JWT does not authorize this method',
    })
  })
  it('rejects invalid parameters before store or blob work', async () => {
    const ctx = await setup()
    for (const query of [
      'uri=at://did:plc:faye/x/y',
      'cid=invalid',
      'uri=x&cid=invalid',
    ])
      expect(
        (
          await fetch(
            `${ctx.base}/xrpc/zone.stratos.feedgen.getBlob?${query}`,
            { headers },
          )
        ).status,
      ).toBe(400)
    expect(ctx.get).not.toHaveBeenCalled()
    expect(ctx.getPost).not.toHaveBeenCalled()
  })
  it.each(['missing', 'unattached', 'wrong-boundary'])(
    'denies %s post without revealing bytes',
    async (condition) => {
      const ctx = await setup({
        boundaries: condition === 'wrong-boundary' ? ['leadership'] : undefined,
      })
      if (condition === 'missing') ctx.getPost.mockResolvedValue(null)
      if (condition === 'unattached') ctx.value.blobRefs = []
      const response = await fetch(ctx.url, { headers })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: 'BlobNotFound',
        message: 'Blob is unavailable',
      })
      expect(ctx.get).not.toHaveBeenCalled()
    },
  )
  it('admits any shared indexed boundary instead of trusting record claims', async () => {
    const value = post()
    value.boundaries = ['leadership', 'engineering']
    value.record.boundary = { value: 'leadership' }
    const ctx = await setup({ post: value })
    expect((await fetch(ctx.url, { headers })).status).toBe(200)
  })
  it.each([
    'viewer',
    'post',
    'boundary',
    'custody',
    'readiness',
    'epoch',
    'pending-viewer',
    'pending-author',
    'author',
  ])('fails closed when %s changes during bytes fetch', async (change) => {
    const ctx = await setup()
    ctx.get.mockImplementation(async () => {
      if (change === 'viewer') ctx.getBoundaries.mockResolvedValue([])
      if (change === 'post') ctx.getPost.mockResolvedValue(null)
      if (change === 'boundary')
        ctx.getPost.mockResolvedValue({
          ...ctx.value,
          boundaries: ['leadership'],
        })
      if (change === 'custody')
        ctx.listSpaceMembers.mockResolvedValue([
          { did: AUTHOR, custody: 'pds' },
        ])
      if (change === 'readiness') ctx.readiness.isReady.mockReturnValue(false)
      if (change === 'epoch')
        vi.spyOn(ctx.mutationFence, 'captureRevocationEpoch').mockReturnValue(1)
      if (change === 'pending-viewer')
        vi.spyOn(ctx.mutationFence, 'hasPendingDidMutation').mockImplementation(
          (did) => did === VIEWER,
        )
      if (change === 'pending-author')
        vi.spyOn(ctx.mutationFence, 'hasPendingDidMutation').mockImplementation(
          (did) => did === AUTHOR,
        )
      if (change === 'author')
        ctx.getPost.mockResolvedValue({ ...ctx.value, did: 'did:plc:jet' })
      return Buffer.from('Spike')
    })
    const response = await fetch(ctx.url, { headers })
    expect(response.status).not.toBe(200)
    expect(await response.json()).toMatchObject(
      ['epoch', 'pending-viewer', 'pending-author'].includes(change)
        ? {
            error: 'FeedNotReady',
            message: 'Blob authorization changed during download',
          }
        : change === 'readiness'
          ? {
              error: 'FeedNotReady',
              message:
                'Feed is unavailable while authorization state is reconciling',
            }
          : { error: 'BlobNotFound', message: 'Blob is unavailable' },
    )
  })
  it('blocks reads before reconciliation and checks readiness after store access', async () => {
    const ctx = await setup({ ready: false })
    expect((await fetch(ctx.url, { headers })).status).toBe(503)
    expect(ctx.getPost).not.toHaveBeenCalled()
    ctx.readiness.isReady.mockReturnValueOnce(true).mockReturnValue(false)
    expect((await fetch(ctx.url, { headers })).status).toBe(503)
    expect(ctx.get).not.toHaveBeenCalled()
  })
  it('supports isolated servers without lifecycle gates', async () => {
    const ctx = await setup({ omitGates: true })
    expect((await fetch(ctx.url, { headers })).status).toBe(200)
  })
  it('uses the requested reference when a post has multiple attachments', async () => {
    const value = post()
    value.blobRefs.unshift({
      cid: 'bafkreicftohjg7qfzr2knf7ysksl5pyvt3xvdk4gijxsflft5ikuhqboy4',
      mimeType: 'image/jpeg',
    })
    const ctx = await setup({ post: value })
    expect(
      (await fetch(ctx.url, { headers })).headers.get('content-type'),
    ).toBe('image/png')
    value.blobRefs.pop()
    const response = await fetch(ctx.url, { headers })
    expect(await response.json()).toMatchObject({
      error: 'BlobNotFound',
      message: 'Blob is unavailable',
    })
  })
  it('does not enumerate custody for posts without attachments', async () => {
    const value = post()
    value.blobRefs = []
    const ctx = await setup({
      post: value,
      lxm: 'zone.stratos.feedgen.getFeed',
    })
    const response = await fetch(
      `${ctx.base}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop`,
      { headers },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      feed: { post: { blobs?: unknown } }[]
    }
    expect(body.feed[0].post.blobs).toBeUndefined()
    expect(ctx.listSpaceMembers).not.toHaveBeenCalled()
  })
  it('uses indexed author for seven-segment Stratos-custody space posts', async () => {
    const ctx = await setup({
      post: post(SPACE_URI),
      members: [{ did: AUTHOR, custody: 'stratos' }],
    })
    expect((await fetch(ctx.url, { headers })).status).toBe(200)
    expect(ctx.get).toHaveBeenCalledExactlyOnceWith(AUTHOR, CID)
  })
  it.each([
    { members: [] },
    { members: [{ did: AUTHOR, custody: 'pds' as const }] },
    { members: [{ did: 'did:plc:jet', custody: 'stratos' as const }] },
  ])(
    'keeps unknown and PDS-hosted space blobs out of the cache path',
    async ({ members }) => {
      const ctx = await setup({ post: post(SPACE_URI), members })
      expect((await fetch(ctx.url, { headers })).status).toBe(400)
      expect(ctx.get).not.toHaveBeenCalled()
    },
  )
  it('adds authenticated attachment views while preserving record CIDs and refs', async () => {
    const value = post()
    const ctx = await setup({
      post: value,
      lxm: 'zone.stratos.feedgen.getFeed',
    })
    const response = await fetch(
      `${ctx.base}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop`,
      { headers },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      feed: { post: Record<string, unknown> }[]
    }
    expect(body.feed[0].post.record).toEqual(value.record)
    expect(body.feed[0].post.cid).toBe(value.cid)
    expect(body.feed[0].post.blobs).toEqual([
      {
        cid: CID,
        mimeType: 'image/png',
        url: `https://feedgen.test/xrpc/zone.stratos.feedgen.getBlob?${new URLSearchParams({ uri: URI, cid: CID })}`,
      },
    ])
  })
  it('leaves PDS attachment refs on the existing client path', async () => {
    const value = post(SPACE_URI)
    const ctx = await setup({
      post: value,
      members: [{ did: AUTHOR, custody: 'pds' }],
      lxm: 'zone.stratos.feedgen.getFeed',
    })
    const response = await fetch(
      `${ctx.base}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop`,
      { headers },
    )
    const body = (await response.json()) as {
      feed: { post: Record<string, unknown> }[]
    }
    expect(body.feed[0].post.blobs).toBeUndefined()
    expect(body.feed[0].post.record).toEqual(value.record)
  })
})
