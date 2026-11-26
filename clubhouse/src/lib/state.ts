import { ownValue } from './dictionary'
import type { RoomAccessState, RoomCatalogEntry } from './types'

export function defaultRoomState(room: RoomCatalogEntry): RoomAccessState {
  return room.available ? 'unjoined' : 'unavailable'
}

export function stateForRoom(
  room: RoomCatalogEntry,
  states: Readonly<Record<string, RoomAccessState>>,
): RoomAccessState {
  return ownValue(states, room.id) ?? defaultRoomState(room)
}
