import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { OAuthRoutesConfig } from '../../src/oauth/routes.js'
import { handleRooms } from '../../src/oauth/handlers/rooms.js'
import { handleRoomStatus } from '../../src/oauth/handlers/room-status.js'
import { handleRoomPost } from '../../src/oauth/handlers/room-post.js'
import { handleAuthorize } from '../../src/oauth/handlers/authorize.js'
import { buildRoomCatalog } from '../../src/oauth/room-catalog.js'

function response() {
  const status = vi.fn().mockReturnThis()
  const json = vi.fn()
  const redirect = vi.fn()
  return {
    status,
    json,
    redirect,
    res: { status, json, redirect } as unknown as Response,
  }
}
describe('fresh OAuth boundary policy', () => {
  it('awaits public catalog refresh and returns an explicit temporary failure', async () => {
    const cfg = {} as OAuthRoutesConfig
    cfg.refreshBoundaryConfiguration = async () => {
      await Promise.resolve()
      cfg.roomCatalog = buildRoomCatalog([
        {
          id: 'bebop',
          boundary: 'did:web:bebop.example/crew',
          displayName: 'Bebop',
          description: 'Crew only',
          available: true,
        },
      ])
    }
    const first = response()
    await handleRooms(cfg)({} as Request, first.res)
    expect(first.json).toHaveBeenCalledWith({
      rooms: [
        {
          id: 'bebop',
          displayName: 'Bebop',
          description: 'Crew only',
          available: true,
        },
      ],
    })
    cfg.refreshBoundaryConfiguration = async () => {
      throw new Error('database unavailable')
    }
    const failed = response()
    await handleRooms(cfg)({} as Request, failed.res)
    expect(failed.status).toHaveBeenCalledWith(503)
    expect(failed.json).toHaveBeenCalledWith({
      error: 'RoomCatalogUnavailable',
      message: 'Room listing is temporarily unavailable',
    })
  })
  it.each([
    [handleRoomStatus, 'RoomStatusError'],
    [handleRoomPost, 'RoomPostError'],
  ] as const)(
    'fails closed before membership or posting when refresh fails',
    async (factory, error) => {
      const authenticate = vi.fn()
      const cfg = {
        refreshBoundaryConfiguration: async () => {
          throw new Error('unavailable')
        },
      } as unknown as OAuthRoutesConfig
      const res = response()
      await factory(cfg, authenticate)({} as Request, res.res)
      expect(authenticate).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error }))
    },
  )
  it('refreshes room availability before starting a selected-room authorization', async () => {
    const room = {
      id: 'bebop',
      boundary: 'did:web:bebop.example/crew',
      displayName: 'Bebop',
      description: 'Crew only',
      available: true,
    }
    const authorize = vi.fn()
    const cfg = {
      baseUrl: 'https://bebop.example',
      serviceDid: 'did:web:bebop.example',
      allowedRedirectOrigins: ['https://client.example'],
      oauthClient: { authorize },
      roomCatalog: buildRoomCatalog([room]),
    } as unknown as OAuthRoutesConfig
    cfg.refreshBoundaryConfiguration = async () => {
      await Promise.resolve()
      cfg.roomCatalog = buildRoomCatalog([{ ...room, available: false }])
    }
    const res = response()
    await handleAuthorize(cfg)(
      {
        query: {
          handle: 'spike.example',
          room: 'bebop',
          redirect_uri: 'https://client.example/return',
        },
      } as unknown as Request,
      res.res,
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: 'InvalidRequest',
      message: 'Unknown or unavailable room',
    })
  })
})
