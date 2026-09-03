import { describe, expect, it } from 'vitest'
import { roomIdFromPath, roomPath } from './route'

describe('room routes', () => {
  it('uses only the room/feed ID in a durable URL', () => {
    expect(roomPath('open-orbit')).toBe('/rooms/open-orbit')
    expect(roomPath('room with spaces')).toBe('/rooms/room%20with%20spaces')
    expect(roomPath('open-orbit')).not.toContain('boundary')
  })

  it('reads IDs and rejects paths outside /rooms/:id', () => {
    expect(roomIdFromPath('/rooms/open-orbit')).toBe('open-orbit')
    expect(roomIdFromPath('/rooms/room%20with%20spaces/')).toBe(
      'room with spaces',
    )
    expect(roomIdFromPath('/rooms/open-orbit?boundary=secret')).toBeNull()
    expect(roomIdFromPath('/rooms/open-orbit/extra')).toBeNull()
    expect(roomIdFromPath('/')).toBeNull()
  })
})
