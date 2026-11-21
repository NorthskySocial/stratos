import { describe, expect, it } from 'vitest'
import { defaultRoomState, stateForRoom } from './state'

const available = {
  id: 'orbit',
  displayName: 'Orbit',
  description: 'A room',
  available: true,
}
const paused = { ...available, id: 'quiet', available: false }

describe('room UI state', () => {
  it('shows available rooms as unjoined and unavailable rooms as unavailable', () => {
    expect(defaultRoomState(available)).toBe('unjoined')
    expect(defaultRoomState(paused)).toBe('unavailable')
  })

  it('uses injected state without treating UI state as authorization', () => {
    expect(stateForRoom(available, { orbit: 'joined' })).toBe('joined')
    expect(stateForRoom(available, {})).toBe('unjoined')
  })

  it('preserves an unavailable status lookup for an informative UI fallback', () => {
    expect(stateForRoom(available, { orbit: 'status-error' })).toBe(
      'status-error',
    )
  })
})

describe('room UI state for rooms named like inherited properties', () => {
  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
  ])(
    'falls back to the default state for the room %s when no state was given for it',
    (roomId) => {
      expect(stateForRoom({ ...available, id: roomId }, {})).toBe('unjoined')
    },
  )

  it.each(['constructor', '__proto__'])(
    'uses the state given for the room %s',
    (roomId) => {
      const states = Object.fromEntries([[roomId, 'joined' as const]])
      expect(stateForRoom({ ...available, id: roomId }, states)).toBe('joined')
    },
  )
})
