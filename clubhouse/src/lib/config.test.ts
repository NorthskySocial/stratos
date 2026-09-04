import { describe, expect, it } from 'vitest'
import {
  feedgenServiceId,
  roomCatalogEndpoint,
  roomPostEndpoint,
  roomStatusEndpoint,
} from './config'

describe('Clubhouse service endpoints', () => {
  it('identifies the Feedgen service for OAuth scopes and PDS proxy routing', () => {
    expect(feedgenServiceId('did:web:feed.example')).toBe(
      'did:web:feed.example#stratos_feedgen',
    )
    expect(feedgenServiceId('did:web:feed.example#custom')).toBe(
      'did:web:feed.example#custom',
    )
  })

  it('derives all room endpoints from the configured Stratos service', () => {
    const config = {
      serviceUrl: 'https://stratos.example/service',
      pdsSpaceUriByRoom: {},
    }
    expect(roomCatalogEndpoint(config)).toBe(
      'https://stratos.example/service/oauth/boundaries',
    )
    expect(roomStatusEndpoint(config)).toBe(
      'https://stratos.example/service/oauth/boundaries/status',
    )
    expect(roomPostEndpoint(config)).toBe(
      'https://stratos.example/service/oauth/boundaries/post',
    )
  })

  it('preserves an explicit room status override', () => {
    expect(
      roomStatusEndpoint({
        serviceUrl: 'https://stratos.example',
        roomStatusEndpoint: 'https://status.example/rooms',
        pdsSpaceUriByRoom: {},
      }),
    ).toBe('https://status.example/rooms')
  })
})
