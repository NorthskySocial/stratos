import { describe, expect, it } from 'vitest'
import { defaultRoomState, stateForRoom } from './state'

const available = { id: 'orbit', displayName: 'Orbit', description: 'A room', available: true }
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

  it('preserves an unavailable status lookup as non-joinable', () => {
    expect(stateForRoom(available, { orbit: 'status-error' })).toBe('status-error')
  })
})
