import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {
    init: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  },
}))

vi.mock('./auth', () => ({
  createClubhouseAuth: vi.fn(() => mocks.auth),
}))

vi.mock('./enrollment', () => ({
  resolveAuthenticatedHandle: vi.fn(),
}))

vi.mock('../telemetry', () => ({
  captureClubhouseException: vi.fn(),
  withClubhouseSpan: vi.fn(<T>(_name: string, work: () => T): T => work()),
}))

import { createClubhouseIntegration } from './integration'
import { resolveAuthenticatedHandle } from './enrollment'
import { captureClubhouseException, withClubhouseSpan } from '../telemetry'
import type { FeedPage } from './feedgen'
import type { TypeaheadActor } from './typeahead'

const session = (fetchHandler: ReturnType<typeof vi.fn>) => ({
  sub: 'did:plc:misato',
  fetchHandler,
})

const fayeProfile: TypeaheadActor = {
  did: 'did:plc:faye',
  handle: 'faye.example',
  displayName: 'Faye Valentine',
  avatar: 'https://cdn.example/faye.jpg',
}

const fayePage: FeedPage = {
  cursor: 'bebop-next',
  posts: [
    {
      uri: 'at://did:plc:faye/zone.stratos.feed.post/1',
      cid: 'bafy-faye',
      indexedAt: '2026-09-04T18:00:00.000Z',
      author: { did: 'did:plc:faye', handle: 'faye.example' },
      text: 'See you, space cowboy.',
    },
  ],
}

function profilesResponse(
  profiles: TypeaheadActor[] = [fayeProfile],
): Response {
  return new Response(JSON.stringify({ profiles }), { status: 200 })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function createFeedIntegration(typeaheadFetcher: typeof fetch) {
  const fetchHandler = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          cursor: fayePage.cursor,
          feed: fayePage.posts.map((post) => ({
            post: { ...post, record: { text: post.text } },
          })),
        }),
        { status: 200 },
      ),
  )
  mocks.auth.init.mockResolvedValue(session(fetchHandler))
  const integration = createClubhouseIntegration(
    { feedgenDid: 'did:web:feed.example', pdsSpaceUriByRoom: {} },
    { typeaheadFetcher },
  )
  await integration.initialize()
  return { integration, fetchHandler }
}

describe('Clubhouse integration', () => {
  beforeEach(() => {
    mocks.auth.init.mockReset()
    mocks.auth.signIn.mockReset()
    mocks.auth.signOut.mockReset()
    vi.mocked(resolveAuthenticatedHandle).mockReset()
    vi.mocked(captureClubhouseException).mockClear()
    vi.mocked(withClubhouseSpan).mockClear()
  })

  it('starts room enrollment with the restored identity without another handle lookup', async () => {
    const fetchHandler = vi.fn()
    const navigate = vi.fn<(url: string) => void>()
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    vi.mocked(resolveAuthenticatedHandle).mockResolvedValue('misato.example')
    const integration = createClubhouseIntegration(
      {
        serviceUrl: 'https://stratos.example',
        publicOrigin: 'https://clubhouse.example',
        pdsSpaceUriByRoom: {},
      },
      { navigate },
    )
    await integration.initialize?.()

    await integration.requestJoin?.('nerv-hq')

    expect(resolveAuthenticatedHandle).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
    const destination = new URL(navigate.mock.calls[0]![0])
    expect(destination.searchParams.get('handle')).toBe('misato.example')
    expect(destination.searchParams.get('room')).toBe('nerv-hq')
  })

  it('uses the signed-in DID when handle resolution is temporarily unavailable', async () => {
    const navigate = vi.fn<(url: string) => void>()
    mocks.auth.init.mockResolvedValue(session(vi.fn()))
    vi.mocked(resolveAuthenticatedHandle).mockRejectedValue(
      new Error('PDS unavailable'),
    )
    const integration = createClubhouseIntegration(
      {
        serviceUrl: 'https://stratos.example',
        publicOrigin: 'https://clubhouse.example',
        pdsSpaceUriByRoom: {},
      },
      { navigate },
    )
    await expect(integration.initialize()).resolves.toEqual({
      did: 'did:plc:misato',
    })
    expect(integration.identity).toEqual({ did: 'did:plc:misato' })

    await integration.requestJoin?.('nerv-hq')

    const destination = new URL(navigate.mock.calls[0]![0])
    expect(destination.searchParams.get('handle')).toBe('did:plc:misato')
  })

  it('resolves the signed-in handle and signs out through browser auth', async () => {
    const fetchHandler = vi.fn()
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    vi.mocked(resolveAuthenticatedHandle).mockResolvedValue('misato.example')
    const integration = createClubhouseIntegration({ pdsSpaceUriByRoom: {} })

    await expect(integration.initialize?.()).resolves.toEqual({
      did: 'did:plc:misato',
      handle: 'misato.example',
    })
    await integration.signOut?.()

    expect(mocks.auth.signOut).toHaveBeenCalledOnce()
    expect(integration.identity).toBeNull()
  })

  it('clears the previous identity when the browser session is no longer available', async () => {
    mocks.auth.init.mockResolvedValue(session(vi.fn()))
    vi.mocked(resolveAuthenticatedHandle).mockResolvedValue('misato.example')
    const integration = createClubhouseIntegration({ pdsSpaceUriByRoom: {} })
    await integration.initialize()
    mocks.auth.init.mockResolvedValue(null)
    vi.mocked(resolveAuthenticatedHandle).mockClear()

    await expect(integration.initialize()).resolves.toBeNull()

    expect(integration.identity).toBeNull()
    expect(resolveAuthenticatedHandle).not.toHaveBeenCalled()
    await expect(integration.getFeed('nerv-hq', 50)).rejects.toThrow(
      'Sign in to read this room.',
    )
  })

  it('loads all room states from Stratos in one boundary-free request', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          rooms: [
            { id: 'nerv-hq', state: 'joined' },
            { id: 'ignore-me', state: 'joined' },
          ],
        }),
        { status: 200 },
      ),
    )
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration({
      serviceUrl: 'https://stratos.example',
      pdsSpaceUriByRoom: {},
    })
    await integration.initialize?.()

    await expect(
      integration.getRoomStates?.(['nerv-hq', 'terminal-dogma']),
    ).resolves.toEqual({ 'nerv-hq': 'joined' })
    expect(fetchHandler).toHaveBeenCalledTimes(1)
    expect(fetchHandler).toHaveBeenCalledWith(
      'https://stratos.example/oauth/boundaries/status',
      { method: 'GET' },
    )
  })

  it('returns readable posts before optional author enrichment settles', async () => {
    const profiles = deferred<Response>()
    const typeaheadFetcher = vi.fn<typeof fetch>(() => profiles.promise)
    const { integration, fetchHandler } =
      await createFeedIntegration(typeaheadFetcher)

    const page = await integration.getFeed('bebop-sessions', 50, 'bebop-start')

    expect(page).toEqual(fayePage)
    expect(typeaheadFetcher).not.toHaveBeenCalled()
    expect(fetchHandler).toHaveBeenCalledWith(
      '/xrpc/zone.stratos.feedgen.getFeed?feed=bebop-sessions&limit=50&cursor=bebop-start',
      expect.objectContaining({ method: 'GET' }),
    )
    const enrichment = integration.enrichFeedAuthors(page)
    expect(typeaheadFetcher).toHaveBeenCalledOnce()
    await expect(integration.getFeed('bebop-sessions', 50)).resolves.toEqual(
      fayePage,
    )

    profiles.resolve(profilesResponse())
    await expect(enrichment).resolves.toEqual({
      ...fayePage,
      posts: [{ ...fayePage.posts[0], author: fayeProfile }],
    })
    expect(page).toEqual(fayePage)
    expect(
      vi.mocked(withClubhouseSpan).mock.calls.map(([name]) => name),
    ).toEqual([
      'clubhouse.session.restore',
      'clubhouse.identity.resolve',
      'clubhouse.feed.transport',
      'clubhouse.feed.authors.enrich',
      'clubhouse.feed.transport',
    ])
  })

  it('uses cached author metadata on subsequent feeds without another lookup', async () => {
    const typeaheadFetcher = vi.fn(async () => profilesResponse())
    const { integration } = await createFeedIntegration(typeaheadFetcher)
    const enriched = await integration.enrichFeedAuthors(fayePage)

    await expect(integration.getFeed('bebop-sessions', 50)).resolves.toEqual(
      enriched,
    )
    await expect(integration.enrichFeedAuthors(fayePage)).resolves.toEqual(
      enriched,
    )
    expect(typeaheadFetcher).toHaveBeenCalledOnce()
  })

  it('deduplicates overlapping author lookups and caches absent profiles', async () => {
    const profiles = deferred<Response>()
    const typeaheadFetcher = vi.fn<typeof fetch>(() => profiles.promise)
    const { integration } = await createFeedIntegration(typeaheadFetcher)
    const spikePost = {
      ...fayePage.posts[0]!,
      uri: 'at://did:plc:spike/zone.stratos.feed.post/2',
      author: { did: 'did:plc:spike' },
    }
    const page = { posts: [...fayePage.posts, ...fayePage.posts, spikePost] }

    const first = integration.enrichFeedAuthors(page)
    const second = integration.enrichFeedAuthors(fayePage)
    expect(typeaheadFetcher).toHaveBeenCalledOnce()
    const requestUrl = new URL(
      vi.mocked(typeaheadFetcher).mock.calls[0]![0] as string,
    )
    expect(requestUrl.searchParams.getAll('actors')).toEqual([
      'did:plc:faye',
      'did:plc:spike',
    ])
    profiles.resolve(profilesResponse())

    const [enriched, overlapping] = await Promise.all([first, second])
    expect(enriched.posts.map((post) => post.author)).toEqual([
      fayeProfile,
      fayeProfile,
      spikePost.author,
    ])
    expect(overlapping.posts[0]?.author).toEqual(fayeProfile)
    await expect(integration.enrichFeedAuthors(page)).resolves.toEqual(enriched)
    expect(typeaheadFetcher).toHaveBeenCalledOnce()
  })

  it('keeps supplied avatars and empty pages without requesting profiles', async () => {
    const typeaheadFetcher = vi.fn()
    const { integration } = await createFeedIntegration(typeaheadFetcher)
    const page = {
      ...fayePage,
      posts: [{ ...fayePage.posts[0]!, author: fayeProfile }],
    }

    await expect(integration.enrichFeedAuthors(page)).resolves.toEqual(page)
    await expect(integration.enrichFeedAuthors({ posts: [] })).resolves.toEqual(
      { posts: [] },
    )
    expect(typeaheadFetcher).not.toHaveBeenCalled()
  })

  it('keeps posts readable after a profile failure and retries on the next enrichment', async () => {
    const error = new Error('Typeahead unavailable')
    const typeaheadFetcher = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async () => profilesResponse())
    const { integration } = await createFeedIntegration(typeaheadFetcher)

    await expect(integration.enrichFeedAuthors(fayePage)).resolves.toEqual(
      fayePage,
    )
    expect(captureClubhouseException).toHaveBeenCalledWith(error)
    const enriched = await integration.enrichFeedAuthors(fayePage)

    expect(enriched.posts[0]?.author).toEqual(fayeProfile)
    expect(typeaheadFetcher).toHaveBeenCalledTimes(2)
  })

  it('discards author enrichment that finishes after signing out', async () => {
    const profiles = deferred<Response>()
    const typeaheadFetcher = vi.fn(() => profiles.promise)
    const { integration } = await createFeedIntegration(typeaheadFetcher)
    const enrichment = integration.enrichFeedAuthors(fayePage)

    await integration.signOut()
    profiles.resolve(profilesResponse())

    await expect(enrichment).resolves.toBe(fayePage)
    await expect(integration.enrichFeedAuthors(fayePage)).resolves.toBe(
      fayePage,
    )
    expect(typeaheadFetcher).toHaveBeenCalledOnce()
    await expect(integration.getFeed('bebop-sessions', 50)).rejects.toThrow(
      'Sign in to read this room.',
    )
  })

  it('isolates author lookups when a new session is restored during enrichment', async () => {
    const oldProfiles = deferred<Response>()
    const currentProfiles = deferred<Response>()
    const typeaheadFetcher = vi
      .fn()
      .mockReturnValueOnce(oldProfiles.promise)
      .mockReturnValueOnce(currentProfiles.promise)
    const { integration } = await createFeedIntegration(typeaheadFetcher)
    const oldEnrichment = integration.enrichFeedAuthors(fayePage)
    mocks.auth.init.mockResolvedValue({
      ...session(vi.fn()),
      sub: 'did:plc:rei',
    })

    await integration.initialize()
    const currentEnrichment = integration.enrichFeedAuthors(fayePage)
    oldProfiles.resolve(profilesResponse())
    await expect(oldEnrichment).resolves.toBe(fayePage)
    const repeatedEnrichment = integration.enrichFeedAuthors(fayePage)
    expect(typeaheadFetcher).toHaveBeenCalledTimes(2)

    const currentProfile = { ...fayeProfile, displayName: 'Faye' }
    currentProfiles.resolve(profilesResponse([currentProfile]))
    const currentPage = await currentEnrichment
    expect(currentPage.posts[0]?.author).toEqual(currentProfile)
    await expect(repeatedEnrichment).resolves.toEqual(currentPage)
    await expect(integration.enrichFeedAuthors(fayePage)).resolves.toEqual(
      currentPage,
    )
    expect(typeaheadFetcher).toHaveBeenCalledTimes(2)
  })

  it('clears cached author metadata when restoring a session', async () => {
    const typeaheadFetcher = vi.fn(async () => profilesResponse())
    const { integration } = await createFeedIntegration(typeaheadFetcher)
    await integration.enrichFeedAuthors(fayePage)

    await integration.initialize()
    await expect(integration.getFeed('bebop-sessions', 50)).resolves.toEqual(
      fayePage,
    )
    await integration.enrichFeedAuthors(fayePage)

    expect(typeaheadFetcher).toHaveBeenCalledTimes(2)
  })

  it('uses the authenticated server custody rather than a forged PDS enrollment record', async () => {
    const fetchHandler = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('com.atproto.repo.getRecord')) {
        return new Response(JSON.stringify({ value: { custody: 'pds' } }), {
          status: 200,
        })
      }
      if (url === 'https://stratos.example/oauth/boundaries/status') {
        return new Response(
          JSON.stringify({
            rooms: [{ id: 'nerv-hq', state: 'joined' }],
            custody: 'stratos',
          }),
          { status: 200 },
        )
      }
      if (url === 'https://stratos.example/oauth/boundaries/post') {
        return new Response(
          JSON.stringify({
            uri: 'at://did:plc:misato/zone.stratos.feed.post/1',
            cid: 'bafy-misato-1',
          }),
          { status: 201 },
        )
      }
      throw new Error(`unexpected request: ${url}`)
    })
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration({
      serviceUrl: 'https://stratos.example',
      pdsSpaceUriByRoom: {
        'nerv-hq':
          'at://did:web:stratos.example/space/zone.stratos.space.feed/nerv-hq',
      },
    })
    await integration.initialize?.()

    await integration.createPost?.('nerv-hq', '  Bridge report.  ')

    expect(fetchHandler).toHaveBeenCalledWith(
      'https://stratos.example/oauth/boundaries/status',
      { method: 'GET' },
    )
    expect(fetchHandler).toHaveBeenCalledWith(
      'https://stratos.example/oauth/boundaries/post',
      expect.objectContaining({ method: 'POST' }),
    )
    const postCall = fetchHandler.mock.calls.find(
      ([url]) => url === 'https://stratos.example/oauth/boundaries/post',
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body).toEqual({ roomId: 'nerv-hq', text: 'Bridge report.' })
    expect(JSON.stringify(body)).not.toContain('boundary')
    expect(fetchHandler).not.toHaveBeenCalledWith(
      expect.stringContaining('com.atproto.repo.getRecord'),
      expect.anything(),
    )
    expect(fetchHandler).not.toHaveBeenCalledWith(
      '/xrpc/com.atproto.space.createRecord',
      expect.anything(),
    )
  })

  it('uses the PDS writer only when the server reports PDS custody', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rooms: [{ id: 'nerv-hq', state: 'joined' }],
            custody: 'pds',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uri: 'at://did:plc:misato/zone.stratos.feed.post/2',
            cid: 'bafy-misato-2',
          }),
          { status: 200 },
        ),
      )
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration({
      serviceUrl: 'https://stratos.example',
      pdsSpaceUriByRoom: {
        'nerv-hq':
          'at://did:web:stratos.example/space/zone.stratos.space.feed/nerv-hq',
      },
    })
    await integration.initialize?.()

    await integration.createPost?.('nerv-hq', 'PDS report.')

    expect(fetchHandler).toHaveBeenCalledWith(
      '/xrpc/com.atproto.space.createRecord',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchHandler).not.toHaveBeenCalledWith(
      'https://stratos.example/oauth/boundaries/post',
      expect.anything(),
    )
  })

  it('rejects a malformed post reference from the Stratos writer', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rooms: [{ id: 'nerv-hq', state: 'joined' }],
            custody: 'stratos',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uri: 'at://did:plc:misato/zone.stratos.feed.post/1',
          }),
          { status: 201 },
        ),
      )
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration({
      serviceUrl: 'https://stratos.example',
      pdsSpaceUriByRoom: {},
    })
    await integration.initialize?.()

    await expect(
      integration.createPost?.('nerv-hq', 'Bridge report.'),
    ).rejects.toThrow('Stratos returned an invalid post reference.')
  })

  it('deletes a Stratos-custodied post through the authenticated service', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rooms: [{ id: 'nerv-hq', state: 'joined' }],
            custody: 'stratos',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration({
      serviceUrl: 'https://stratos.example',
      pdsSpaceUriByRoom: {},
    })
    await integration.initialize?.()

    await integration.deletePost?.('nerv-hq', {
      uri: 'at://did:plc:misato/zone.stratos.feed.post/3k5',
      cid: 'bafy-misato-3k5',
      author: { did: 'did:plc:misato' },
      text: 'Delete this report.',
      indexedAt: '2026-09-04T18:00:00.000Z',
    })

    expect(fetchHandler).toHaveBeenLastCalledWith(
      'https://stratos.example/oauth/boundaries/post',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uri: 'at://did:plc:misato/zone.stratos.feed.post/3k5',
          cid: 'bafy-misato-3k5',
        }),
      },
    )
  })

  it('deletes a PDS-custodied post through the actor repository', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            rooms: [{ id: 'nerv-hq', state: 'joined' }],
            custody: 'pds',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration({
      serviceUrl: 'https://stratos.example',
      pdsSpaceUriByRoom: {},
    })
    await integration.initialize?.()

    await integration.deletePost?.('nerv-hq', {
      uri: 'at://did:plc:misato/zone.stratos.feed.post/3k6',
      cid: 'bafy-misato-3k6',
      author: { did: 'did:plc:misato' },
      text: 'Delete this PDS report.',
      indexedAt: '2026-09-04T18:00:00.000Z',
    })

    expect(fetchHandler).toHaveBeenLastCalledWith(
      '/xrpc/com.atproto.repo.deleteRecord',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
