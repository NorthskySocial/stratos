import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: {
    init: vi.fn(),
    signIn: vi.fn(),
  },
}))

vi.mock('./auth', () => ({
  createClubhouseAuth: vi.fn(() => mocks.auth),
}))

vi.mock('./enrollment', () => ({
  resolveAuthenticatedHandle: vi.fn(),
}))

import { createClubhouseIntegration } from './integration'

const session = (fetchHandler: ReturnType<typeof vi.fn>) => ({
  sub: 'did:plc:misato',
  fetchHandler,
})

describe('Clubhouse integration', () => {
  beforeEach(() => {
    mocks.auth.init.mockReset()
    mocks.auth.signIn.mockReset()
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
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
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
})
