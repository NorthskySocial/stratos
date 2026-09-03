import {
  clubhouseClientId,
  clubhouseRedirectUri,
  type ClubhouseConfig,
} from './config'

const RETURN_ROOM_STORAGE_KEY = 'clubhouse:pending-room-return'
const JOIN_ROOM_STORAGE_KEY = 'clubhouse:pending-room-join'

/** Build the service-owned selected-room enrollment URL from a public feed ID. */
export function roomJoinUrl(
  config: ClubhouseConfig,
  roomId: string,
  handle: string,
  returnPath: string,
): URL {
  if (!config.serviceUrl) throw new Error('Room enrollment needs a Stratos service URL')
  if (!roomId.trim()) throw new Error('A room ID is required')
  if (!handle.trim()) throw new Error('A signed-in handle is required')
  if (!returnPath.startsWith('/rooms/')) throw new Error('Room return path is invalid')
  const url = new URL('/oauth/authorize', config.serviceUrl)
  url.searchParams.set('handle', handle)
  url.searchParams.set('room', roomId)
  url.searchParams.set('redirect_uri', clubhouseRedirectUri(config))
  url.searchParams.set('client_id', clubhouseClientId(config))
  return url
}

/** Keep a public room route across the server-owned enrollment redirect. */
export function rememberRoomReturn(returnPath: string): void {
  if (!returnPath.startsWith('/rooms/')) throw new Error('Room return path is invalid')
  window.sessionStorage.setItem(RETURN_ROOM_STORAGE_KEY, returnPath)
}

/** Consume the route after a successful server callback; it carries no authority. */
export function consumeRoomReturn(): string | null {
  const returnPath = window.sessionStorage.getItem(RETURN_ROOM_STORAGE_KEY)
  window.sessionStorage.removeItem(RETURN_ROOM_STORAGE_KEY)
  return returnPath?.startsWith('/rooms/') ? returnPath : null
}

/** Keep a public room ID while the visitor first completes browser sign-in. */
export function rememberRoomJoin(roomId: string): void {
  const id = roomId.trim()
  if (!id) throw new Error('A room ID is required')
  window.sessionStorage.setItem(JOIN_ROOM_STORAGE_KEY, id)
}

/** Consume the room chosen before browser sign-in; it is never authority. */
export function consumeRoomJoin(): string | null {
  const roomId = window.sessionStorage.getItem(JOIN_ROOM_STORAGE_KEY)
  window.sessionStorage.removeItem(JOIN_ROOM_STORAGE_KEY)
  return roomId?.trim() || null
}
