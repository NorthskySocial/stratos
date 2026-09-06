import { describe, expect, it, vi } from 'vitest'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  handleRoomPost,
  handleRoomPostDelete,
} from '../src/oauth/handlers/room-post.js'
import { buildRoomCatalog } from '../src/oauth/room-catalog.js'
import type { OAuthRoutesConfig } from '../src/oauth/routes.js'

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  }
  response.status.mockReturnValue(response)
  return response
}

function createConfig(): OAuthRoutesConfig {
  return {
    roomCatalog: buildRoomCatalog([
      {
        id: 'nerv-hq',
        boundary: 'did:web:stratos.example/nerv-hq',
        displayName: 'NERV HQ',
        description: 'Operational reports.',
        available: true,
      },
    ]),
    enrollmentStore: {
      getEnrollment: vi.fn(),
      getBoundaries: vi.fn(),
    },
    createApprovedRoomPost: vi.fn().mockResolvedValue({
      uri: 'at://did:plc:misato/zone.stratos.feed.post/1',
      cid: 'bafy-misato',
    }),
    deleteApprovedRoomPost: vi.fn().mockResolvedValue(undefined),
  } as unknown as OAuthRoutesConfig
}

describe('server-approved room posts', () => {
  it.each([
    null,
    {},
    { roomId: 'nerv-hq' },
    { text: 'Checking in.' },
    { roomId: '   ', text: 'Checking in.' },
    { roomId: 'nerv-hq', text: '   ' },
  ])('rejects malformed room post input %#', async (body) => {
    const config = createConfig()
    const response = createResponse()

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:rei'))(
      { body } as never,
      response as never,
    )

    expect(config.createApprovedRoomPost).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      error: 'InvalidRoomPost',
      message: 'A room ID and non-empty text are required',
    })
  })

  it('resolves a room ID server-side before creating a membership-scoped post', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:misato',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:misato',
      custody: 'stratos',
    })
    vi.mocked(config.enrollmentStore.getBoundaries).mockResolvedValue([
      'did:web:stratos.example/nerv-hq',
    ])
    const response = createResponse()

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:misato'))(
      { body: { roomId: 'nerv-hq', text: '  Bridge report.  ' } } as never,
      response as never,
    )

    expect(config.createApprovedRoomPost).toHaveBeenCalledWith({
      did: 'did:plc:misato',
      boundary: 'did:web:stratos.example/nerv-hq',
      text: 'Bridge report.',
    })
    expect(response.status).toHaveBeenCalledWith(201)
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'boundary',
    )
  })

  it('passes valid thread references to the approved writer', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:misato',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:misato',
    })
    vi.mocked(config.enrollmentStore.getBoundaries).mockResolvedValue([
      'did:web:stratos.example/nerv-hq',
    ])
    const response = createResponse()
    const reply = {
      root: {
        uri: 'at://did:plc:rei/zone.stratos.feed.post/root',
        cid: 'bafy-root',
      },
      parent: {
        uri: 'at://did:plc:faye/zone.stratos.feed.post/parent',
        cid: 'bafy-parent',
      },
    }

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:misato'))(
      { body: { roomId: 'nerv-hq', text: 'Replying.', reply } } as never,
      response as never,
    )

    expect(config.createApprovedRoomPost).toHaveBeenCalledWith({
      did: 'did:plc:misato',
      boundary: 'did:web:stratos.example/nerv-hq',
      text: 'Replying.',
      reply,
    })
  })

  it('does not call the writer for an unjoined room', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:rei',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:rei',
    })
    vi.mocked(config.enrollmentStore.getBoundaries).mockResolvedValue([])
    const response = createResponse()

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:rei'))(
      { body: { roomId: 'nerv-hq', text: 'Checking in.' } } as never,
      response as never,
    )

    expect(config.createApprovedRoomPost).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(403)
    expect(response.json).toHaveBeenCalledWith({
      error: 'RoomMembershipRequired',
      message: 'Join this room before posting',
    })
  })

  it('reports a missing operator catalogue as a configuration failure', async () => {
    const config = createConfig()
    config.roomCatalog = undefined
    const response = createResponse()

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:rei'))(
      { body: { roomId: 'nerv-hq', text: 'Checking in.' } } as never,
      response as never,
    )

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({
      error: 'RoomCatalogUnavailable',
      message: 'Room posting is not configured for this service',
    })
  })

  it('preserves expected error category without exposing backend details', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:misato',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:misato',
    })
    vi.mocked(config.enrollmentStore.getBoundaries).mockResolvedValue([
      'did:web:stratos.example/nerv-hq',
    ])
    vi.mocked(config.createApprovedRoomPost).mockRejectedValue(
      new InvalidRequestError(
        "Boundary 'did:web:stratos.example/nerv-hq' failed backend validation",
        'InvalidRecord',
      ),
    )
    const response = createResponse()

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:misato'))(
      { body: { roomId: 'nerv-hq', text: 'Checking in.' } } as never,
      response as never,
    )

    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      error: 'InvalidRecord',
      message: 'The room post is invalid',
    })
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'did:web:stratos.example/nerv-hq',
    )
  })

  it('falls back to a safe category when an XRPC error name is unsafe', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:misato',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:misato',
    })
    vi.mocked(config.enrollmentStore.getBoundaries).mockResolvedValue([
      'did:web:stratos.example/nerv-hq',
    ])
    const backendError = new InvalidRequestError(
      'internal boundary detail',
      'InvalidRecord',
    )
    Object.defineProperty(backendError, 'customErrorName', {
      value: 'unsafe category!',
    })
    vi.mocked(config.createApprovedRoomPost).mockRejectedValue(backendError)
    const response = createResponse()

    await handleRoomPost(config, vi.fn().mockResolvedValue('did:plc:misato'))(
      { body: { roomId: 'nerv-hq', text: 'Checking in.' } } as never,
      response as never,
    )

    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      error: 'RoomPostRejected',
      message: 'The room post request was rejected',
    })
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'internal boundary detail',
    )
  })

  it('deletes a room post owned by the authenticated actor', async () => {
    const config = createConfig()
    const response = createResponse()

    await handleRoomPostDelete(
      config,
      vi.fn().mockResolvedValue('did:plc:misato'),
    )(
      {
        body: {
          uri: 'at://did:plc:misato/zone.stratos.feed.post/3k5',
          cid: 'bafy-misato',
        },
      } as never,
      response as never,
    )

    expect(config.deleteApprovedRoomPost).toHaveBeenCalledWith({
      did: 'did:plc:misato',
      rkey: '3k5',
      cid: 'bafy-misato',
    })
    expect(response.status).toHaveBeenCalledWith(200)
  })

  it('rejects deleting another actor room post', async () => {
    const config = createConfig()
    const response = createResponse()

    await handleRoomPostDelete(
      config,
      vi.fn().mockResolvedValue('did:plc:rei'),
    )(
      {
        body: {
          uri: 'at://did:plc:asuka/zone.stratos.feed.post/3k6',
          cid: 'bafy-asuka',
        },
      } as never,
      response as never,
    )

    expect(config.deleteApprovedRoomPost).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(403)
    expect(response.json).toHaveBeenCalledWith({
      error: 'PostOwnershipRequired',
      message: 'You can only delete your own room posts',
    })
  })

  it.each([
    undefined,
    null,
    'invalid',
    {},
    { uri: 1, cid: 'bafy-rei' },
    { uri: 'at://did:plc:rei/zone.stratos.feed.post/3k7', cid: 1 },
    { uri: 'not-an-at-uri', cid: 'bafy-rei' },
    { uri: 'at://did:plc:rei/app.bsky.feed.post/3k7', cid: 'bafy-rei' },
    { uri: 'at://did:plc:rei/zone.stratos.feed.post', cid: 'bafy-rei' },
    { uri: 'at://did:plc:rei/zone.stratos.feed.post/3k7' },
    {
      uri: 'at://did:plc:rei/zone.stratos.feed.post/3k7',
      cid: '',
    },
  ])('rejects malformed room post deletion input %#', async (body) => {
    const config = createConfig()
    const response = createResponse()

    await handleRoomPostDelete(
      config,
      vi.fn().mockResolvedValue('did:plc:rei'),
    )({ body } as never, response as never)

    expect(config.deleteApprovedRoomPost).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(400)
  })
})
