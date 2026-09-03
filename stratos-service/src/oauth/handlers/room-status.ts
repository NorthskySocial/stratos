import express from 'express'
import type { OAuthRoutesConfig } from '../routes.js'

type RoomAccessState = 'joined' | 'unjoined' | 'unavailable'

interface RoomAccessDescription {
  id: string
  state: RoomAccessState
}

type SafeCustody = 'stratos' | 'pds'

function custodyForActiveEnrollment(
  enrollment: Awaited<ReturnType<OAuthRoutesConfig['enrollmentStore']['getEnrollment']>>,
): SafeCustody | undefined {
  if (enrollment?.active !== true) return undefined
  // Normalize at the service boundary. Browser-owned records must never
  // participate in this choice, and an unexpected stored value fails to the
  // service-owned writer rather than enabling the PDS writer.
  return enrollment.custody === 'pds' ? 'pds' : 'stratos'
}

function stateForRoom(deps: {
  boundary: string
  available: boolean
  memberBoundaries: ReadonlySet<string>
}): RoomAccessState {
  if (deps.memberBoundaries.has(deps.boundary)) return 'joined'
  return deps.available ? 'unjoined' : 'unavailable'
}

/**
 * Return a signed-in viewer's room membership as public room IDs only.
 * Boundaries remain service-side authorization data and are never serialized.
 */
export const handleRoomStatus = (
  config: OAuthRoutesConfig,
  authenticateRequest: (
    req: express.Request,
    res: express.Response,
  ) => Promise<string | null>,
) => {
  return async (req: express.Request, res: express.Response) => {
    try {
      const did = await authenticateRequest(req, res)
      if (!did) return

      if (!config.roomCatalog) {
        res.status(503).json({
          error: 'RoomCatalogUnavailable',
          message: 'Room membership is not configured for this service',
        })
        return
      }

      const enrollment = await config.enrollmentStore.getEnrollment(did)
      const boundaries =
        enrollment?.active === true
          ? await config.enrollmentStore.getBoundaries(did)
          : []
      const memberBoundaries = new Set(boundaries)
      const rooms: RoomAccessDescription[] = config.roomCatalog
        .list()
        .map((room) => ({
          id: room.id,
          state: stateForRoom({
            boundary: room.boundary,
            available: room.available,
            memberBoundaries,
          }),
        }))

      const custody = custodyForActiveEnrollment(enrollment)
      res.json({
        rooms,
        ...(custody ? { custody } : {}),
      })
    } catch (err) {
      config.logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'room status check failed',
      )
      res.status(500).json({
        error: 'RoomStatusError',
        message: 'Failed to check room membership',
      })
    }
  }
}
