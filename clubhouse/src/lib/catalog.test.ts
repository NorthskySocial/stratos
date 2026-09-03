import { describe, expect, it, vi } from 'vitest'
import { fetchRoomCatalog, parseRoomCatalog, RoomCatalogError } from './catalog'

describe('room catalogue', () => {
  it('keeps only the public room fields', () => {
    expect(
      parseRoomCatalog({
        rooms: [
          {
            id: 'orbit',
            displayName: 'Orbit',
            description: 'A room',
            available: true,
            boundary: 'must-not-cross',
          },
        ],
      }),
    ).toEqual([
      {
        id: 'orbit',
        displayName: 'Orbit',
        description: 'A room',
        available: true,
      },
    ])
  })

  it('rejects malformed payloads', () => {
    expect(() => parseRoomCatalog({ rooms: [{ id: 'orbit' }] })).toThrow(
      RoomCatalogError,
    )
    expect(() => parseRoomCatalog({ rooms: 'not-an-array' })).toThrow(
      'valid rooms',
    )
  })

  it('fetches GET /oauth/boundaries and reports HTTP failures', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ rooms: [] }), { status: 200 }),
      )
    await expect(
      fetchRoomCatalog(fetcher, '/oauth/boundaries'),
    ).resolves.toEqual([])
    expect(fetcher).toHaveBeenCalledWith('/oauth/boundaries', {
      headers: { Accept: 'application/json' },
    })

    fetcher.mockResolvedValue(new Response('', { status: 503 }))
    await expect(fetchRoomCatalog(fetcher)).rejects.toThrow('HTTP 503')
  })
})
