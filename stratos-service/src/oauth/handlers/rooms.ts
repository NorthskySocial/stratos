import express from 'express'
import type { OAuthRoutesConfig } from '../routes.js'
import type { RoomDescription } from '../room-catalog.js'

interface PublicRoomDescription {
  id: string
  displayName: string
  description: string
  available: boolean
}

function publicRoomDescription(room: RoomDescription): PublicRoomDescription {
  return {
    id: room.id,
    displayName: room.displayName,
    description: room.description,
    available: room.available,
  }
}

/** Public display catalogue. OAuth authorization still resolves IDs server-side. */
export const handleRooms = (config: OAuthRoutesConfig) => {
  return (_req: express.Request, res: express.Response) => {
    if (!config.roomCatalog) {
      res.status(503).json({
        error: 'RoomCatalogUnavailable',
        message: 'Room listing is not configured for this service',
      })
      return
    }

    res.json({
      rooms: config.roomCatalog.list().map(publicRoomDescription),
    })
  }
}
