import { StratosError } from '@northskysocial/stratos-core'
import type { RoomCatalog } from './room-catalog.js'

export interface RoomOAuthState {
  roomId: string
  boundary: string
  redirectTo: string
}

const ROOM_STATE_KIND = 'stratos-room-enrollment-v1'

/**
 * Room state is the only structured state emitted by this service. Generic
 * clients use an opaque string (normally a redirect URI), so only a
 * JSON-shaped state is handed to the strict room-state decoder. This also
 * ensures truncated or otherwise malformed room payloads fail closed.
 */
export function isRoomOAuthStateCandidate(state: string | null): boolean {
  return typeof state === 'string' && state.trimStart().startsWith('{')
}

/** Serialize only values verified before OAuth starts. */
export function encodeRoomOAuthState(state: RoomOAuthState): string {
  return JSON.stringify({ kind: ROOM_STATE_KIND, ...state })
}

/**
 * The OAuth library returns the server-stored state once and deletes it. Still
 * validate its shape and the current catalogue so removed rooms fail closed.
 */
export function decodeRoomOAuthState(
  state: string | null,
  catalog: RoomCatalog,
): RoomOAuthState {
  if (typeof state !== 'string') throw new InvalidRoomOAuthStateError()
  let parsed: unknown
  try {
    parsed = JSON.parse(state)
  } catch {
    throw new InvalidRoomOAuthStateError()
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidRoomOAuthStateError()
  }
  const value = parsed as Record<string, unknown>
  if (
    value['kind'] !== ROOM_STATE_KIND ||
    typeof value['roomId'] !== 'string' ||
    typeof value['boundary'] !== 'string' ||
    typeof value['redirectTo'] !== 'string'
  ) {
    throw new InvalidRoomOAuthStateError()
  }
  const room = catalog.get(value['roomId'])
  if (!room || !room.available || room.boundary !== value['boundary']) {
    throw new InvalidRoomOAuthStateError()
  }
  return {
    roomId: value['roomId'],
    boundary: value['boundary'],
    redirectTo: value['redirectTo'],
  }
}

export class InvalidRoomOAuthStateError extends StratosError {
  constructor() {
    super(
      'The room enrollment state is missing, invalid, or no longer available',
      'InvalidRoomOAuthState',
    )
    this.name = 'InvalidRoomOAuthStateError'
  }
}
