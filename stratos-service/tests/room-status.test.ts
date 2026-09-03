import { describe, expect, it, vi } from 'vitest'
import { handleRoomStatus } from '../src/oauth/handlers/room-status.js'
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
        id: 'bebop',
        boundary: 'did:web:stratos.example/bebop',
        displayName: 'Bebop',
        description: 'Cowboy Bebop night shift.',
        available: true,
      },
      {
        id: 'maintenance',
        boundary: 'did:web:stratos.example/maintenance',
        displayName: 'Maintenance',
        description: 'Temporarily closed.',
        available: false,
      },
    ]),
    enrollmentStore: {
      getEnrollment: vi.fn(),
      getBoundaries: vi.fn(),
    },
  } as unknown as OAuthRoutesConfig
}

describe('room membership status', () => {
  it('returns ID-only server-derived membership states and active-store custody', async () => {
    const config = createConfig()
    const store = config.enrollmentStore
    vi.mocked(store.getEnrollment).mockResolvedValue({
      did: 'did:plc:faye',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:faye',
      custody: 'pds',
    })
    vi.mocked(store.getBoundaries).mockResolvedValue([
      'did:web:stratos.example/bebop',
      'did:web:stratos.example/maintenance',
    ])
    const response = createResponse()
    const authenticateRequest = vi.fn().mockResolvedValue('did:plc:faye')

    const handler = handleRoomStatus(config, authenticateRequest)
    await handler({} as never, response as never)

    expect(response.json).toHaveBeenCalledWith({
      rooms: [
        { id: 'bebop', state: 'joined' },
        { id: 'maintenance', state: 'joined' },
      ],
      custody: 'pds',
    })
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'boundary',
    )
  })

  it('does not emit custody for an inactive enrollment', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:rei',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: false,
      signingKeyDid: 'did:key:rei',
      custody: 'pds',
    })
    const response = createResponse()

    await handleRoomStatus(config, vi.fn().mockResolvedValue('did:plc:rei'))(
      {} as never,
      response as never,
    )

    expect(response.json).toHaveBeenCalledWith({
      rooms: [
        { id: 'bebop', state: 'unjoined' },
        { id: 'maintenance', state: 'unavailable' },
      ],
    })
  })

  it('defaults an active enrollment without stored custody to the Stratos writer', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue({
      did: 'did:plc:jet',
      enrolledAt: '2026-09-03T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:jet',
    })
    vi.mocked(config.enrollmentStore.getBoundaries).mockResolvedValue([])
    const response = createResponse()

    await handleRoomStatus(config, vi.fn().mockResolvedValue('did:plc:jet'))(
      {} as never,
      response as never,
    )

    expect(response.json).toHaveBeenCalledWith({
      rooms: [
        { id: 'bebop', state: 'unjoined' },
        { id: 'maintenance', state: 'unavailable' },
      ],
      custody: 'stratos',
    })
  })

  it('reports unavailable when room membership has not been configured', async () => {
    const config = createConfig()
    config.roomCatalog = undefined
    const response = createResponse()

    await handleRoomStatus(config, vi.fn().mockResolvedValue('did:plc:ed'))(
      {} as never,
      response as never,
    )

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({
      error: 'RoomCatalogUnavailable',
      message: 'Room membership is not configured for this service',
    })
    expect(config.enrollmentStore.getEnrollment).not.toHaveBeenCalled()
  })

  it('keeps unavailable rooms closed only to new members', async () => {
    const config = createConfig()
    vi.mocked(config.enrollmentStore.getEnrollment).mockResolvedValue(null)
    const response = createResponse()
    const authenticateRequest = vi.fn().mockResolvedValue('did:plc:rei')

    await handleRoomStatus(config, authenticateRequest)(
      {} as never,
      response as never,
    )

    expect(response.json).toHaveBeenCalledWith({
      rooms: [
        { id: 'bebop', state: 'unjoined' },
        { id: 'maintenance', state: 'unavailable' },
      ],
    })
    expect(config.enrollmentStore.getBoundaries).not.toHaveBeenCalled()
  })

  it('does not inspect membership when authentication fails', async () => {
    const config = createConfig()
    const response = createResponse()
    const authenticateRequest = vi.fn().mockResolvedValue(null)

    await handleRoomStatus(config, authenticateRequest)(
      {} as never,
      response as never,
    )

    expect(config.enrollmentStore.getEnrollment).not.toHaveBeenCalled()
    expect(response.json).not.toHaveBeenCalled()
  })
})
