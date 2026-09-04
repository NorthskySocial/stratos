import { describe, expect, it } from 'vitest'
import { roomIdFromPath, roomPath, topicPath, topicUriFromPath } from './route'

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
    expect(roomIdFromPath('/rooms/open-orbit?topic=ignored')).toBe('open-orbit')
    expect(roomIdFromPath('/rooms/open-orbit/extra')).toBeNull()
    expect(roomIdFromPath('/')).toBeNull()
  })

  it('round-trips a topic AT URI in a shareable room URL', () => {
    const uri = 'at://did:plc:rei/zone.stratos.feed.post/3kabc'
    const path = topicPath('open-orbit', uri)
    expect(path).toBe(`/rooms/open-orbit?topic=${encodeURIComponent(uri)}`)
    expect(topicUriFromPath(path)).toBe(uri)
    expect(topicUriFromPath('/rooms/open-orbit?topic=https%3A%2F%2Fbad')).toBeNull()
  })
})
