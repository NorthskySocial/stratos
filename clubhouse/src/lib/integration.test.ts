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
}))

import { createClubhouseIntegration } from './integration'
import { resolveAuthenticatedHandle } from './enrollment'

const session = (fetchHandler: ReturnType<typeof vi.fn>) => ({
  sub: 'did:plc:misato',
  fetchHandler,
})

describe('Clubhouse integration', () => {
  beforeEach(() => {
    mocks.auth.init.mockReset()
    mocks.auth.signIn.mockReset()
    mocks.auth.signOut.mockReset()
    vi.mocked(resolveAuthenticatedHandle).mockReset()
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
    await integration.initialize?.()

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

  it('hydrates feed authors with Typeahead profile avatars', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:faye/zone.stratos.feed.post/1',
                cid: 'bafy-faye',
                indexedAt: '2026-09-04T18:00:00.000Z',
                author: { did: 'did:plc:faye', handle: 'faye.example' },
                record: { text: 'See you, space cowboy.' },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const typeaheadFetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          profiles: [
            {
              did: 'did:plc:faye',
              handle: 'faye.example',
              displayName: 'Faye Valentine',
              avatar: 'https://cdn.example/faye.jpg',
            },
          ],
        }),
        { status: 200 },
      ),
    )
    mocks.auth.init.mockResolvedValue(session(fetchHandler))
    const integration = createClubhouseIntegration(
      { feedgenDid: 'did:web:feed.example', pdsSpaceUriByRoom: {} },
      { typeaheadFetcher },
    )
    await integration.initialize?.()

    const page = await integration.getFeed?.('bebop-sessions', 50)

    expect(page?.posts[0]?.author).toEqual({
      did: 'did:plc:faye',
      handle: 'faye.example',
      displayName: 'Faye Valentine',
      avatar: 'https://cdn.example/faye.jpg',
    })
    expect(typeaheadFetcher).toHaveBeenCalledOnce()
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
