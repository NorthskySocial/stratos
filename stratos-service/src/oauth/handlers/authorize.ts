import express from 'express'
import { buildOAuthScope } from '../client.js'
import {
  type RedirectTargetGates,
  type RedirectTargetVerdict,
  verifyRedirectTarget,
} from '../redirect-target.js'
import type { OAuthRoutesConfig } from '../routes.js'
import type { RoomCatalog, RoomDescription } from '../room-catalog.js'
import { encodeRoomOAuthState } from '../room-oauth-state.js'

/**
 * Tells a client developer how to make its own redirect target acceptable.
 *
 * A rejection here is almost always a client that did not send `client_id`,
 * so the message names the fix instead of only the failure.
 */
const HOW_TO_PROVE_REDIRECT =
  'Publish a client metadata document that declares this redirect_uri, then pass its URL as client_id.'

interface RoomSelection {
  room?: RoomDescription
  error?: string
}

function selectRoom(
  catalog: RoomCatalog | undefined,
  roomId: string | undefined,
  redirectUri: string | undefined,
): RoomSelection {
  // Room selection is an opt-in extension. Existing generic OAuth clients do
  // not send `room`, even when the deployment exposes a room catalogue, and
  // must retain the normal default-boundary enrollment path.
  if (!catalog || roomId === undefined) return {}

  const room = catalog.get(roomId)
  if (!room || !room.available) {
    return { error: 'Unknown or unavailable room' }
  }
  if (!redirectUri) {
    return { error: 'redirect_uri parameter required for room enrollment' }
  }

  return { room }
}

async function verifyAuthorizeRedirect(deps: {
  redirectUri: string | undefined
  clientId: string | undefined
  redirectGates: RedirectTargetGates
  fetchClientRedirectUris: OAuthRoutesConfig['fetchClientRedirectUris']
}): Promise<RedirectTargetVerdict | undefined> {
  if (!deps.redirectUri) return undefined

  return verifyRedirectTarget(
    deps.redirectUri,
    deps.clientId,
    deps.redirectGates,
    deps.fetchClientRedirectUris,
  )
}

function createAuthorizationState(
  selectedRoom: RoomDescription | undefined,
  redirectUri: string | undefined,
): string | undefined {
  if (!selectedRoom) return redirectUri
  if (!redirectUri) {
    throw new Error('Selected room enrollment requires a verified redirect')
  }

  return encodeRoomOAuthState({
    roomId: selectedRoom.id,
    boundary: selectedRoom.boundary,
    redirectTo: redirectUri,
  })
}

function isResolutionError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase()
  return ['resolve', 'handle', 'did', 'discovery'].some((term) =>
    normalizedMessage.includes(term),
  )
}

/**
 * Handles the OAuth authorization flow.
 *
 * @param config - OAuth routes configuration
 * @returns Express handler function
 */
export const handleAuthorize = (config: OAuthRoutesConfig) => {
  const { oauthClient, serviceDid, logger } = config
  const scope = buildOAuthScope(serviceDid)
  const redirectGates: RedirectTargetGates = {
    allowedSchemes: config.baseUrl.startsWith('https://')
      ? ['https:']
      : ['http:', 'https:'],
    allowedRedirectOrigins: config.allowedRedirectOrigins,
    devMode: config.devMode ?? false,
  }

  return async (req: express.Request, res: express.Response) => {
    const handle = req.query.handle as string
    const redirectUri = req.query.redirect_uri as string | undefined
    const clientId = req.query.client_id as string | undefined
    const roomId = req.query.room as string | undefined

    if (!handle) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'Handle parameter required',
      })
    }

    const selection = selectRoom(config.roomCatalog, roomId, redirectUri)
    if (selection.error) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: selection.error,
      })
    }

    try {
      const redirectVerdict = await verifyAuthorizeRedirect({
        redirectUri,
        clientId,
        redirectGates,
        fetchClientRedirectUris: config.fetchClientRedirectUris,
      })
      if (redirectVerdict && !redirectVerdict.allowed) {
        logger?.warn(
          {
            clientId,
            message: redirectVerdict.message,
            detail: redirectVerdict.logDetail,
          },
          'rejected enrollment redirect_uri',
        )
        return res.status(400).json({
          error: 'InvalidRequest',
          message: redirectVerdict.message,
          hint: HOW_TO_PROVE_REDIRECT,
        })
      }

      logger?.debug({ handle, scope }, 'Starting OAuth authorization')
      const state = createAuthorizationState(selection.room, redirectUri)
      const authUrl = await oauthClient.authorize(handle, { scope, state })

      res.redirect(authUrl.toString())
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const errorStack = err instanceof Error ? err.stack : undefined
      logger?.error(
        { err: errorMsg, stack: errorStack, handle: req.query.handle },
        'OAuth authorize failed',
      )
      console.error('OAuth authorize failed:', errorMsg, errorStack)

      res.status(isResolutionError(errorMsg) ? 400 : 500).json({
        error: 'AuthorizationError',
        message: config.devMode
          ? `Failed to start authorization flow: ${errorMsg}`
          : 'Failed to start authorization flow',
      })
    }
  }
}
