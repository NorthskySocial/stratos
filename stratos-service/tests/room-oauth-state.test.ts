import { describe, expect, it } from 'vitest'
import {
  decodeRoomOAuthState,
  encodeRoomOAuthState,
  InvalidRoomOAuthStateError,
} from '../src/oauth/room-oauth-state.js'
import { buildRoomCatalog } from '../src/oauth/room-catalog.js'

const room = {
  id: 'bebop',
  boundary: 'did:web:stratos.example/nebula',
  displayName: 'Bebop',
  description: 'See you, space cowboy.',
  available: true,
}

const catalog = buildRoomCatalog([room])

describe('room OAuth state', () => {
  it('round-trips only a verified room and redirect', () => {
    const encoded = encodeRoomOAuthState({
      roomId: room.id,
      boundary: room.boundary,
      redirectTo: 'https://clubhouse.example/after-oauth',
    })

    expect(decodeRoomOAuthState(encoded, catalog)).toEqual({
      roomId: room.id,
      boundary: room.boundary,
      redirectTo: 'https://clubhouse.example/after-oauth',
    })
  })

  it.each([
    [null, 'missing'],
    ['not-json', 'malformed'],
    [JSON.stringify({ kind: 'wrong-kind' }), 'wrong kind'],
    [
      JSON.stringify({ kind: 'stratos-room-enrollment-v1', roomId: 'bebop' }),
      'missing fields',
    ],
  ])('rejects %s state (%s)', (state, _description) => {
    expect(() => decodeRoomOAuthState(state, catalog)).toThrow(
      InvalidRoomOAuthStateError,
    )
  })

  it.each([
    [
      JSON.stringify({
        kind: 'wrong-kind',
        roomId: room.id,
        boundary: room.boundary,
        redirectTo: 'https://clubhouse.example/after-oauth',
      }),
      'wrong kind',
    ],
    [
      JSON.stringify({
        kind: 'stratos-room-enrollment-v1',
        roomId: room.id,
        boundary: room.boundary,
        redirectTo: 42,
      }),
      'non-string redirectTo',
    ],
  ])('rejects an otherwise-valid payload with %s', (state, _description) => {
    expect(() => decodeRoomOAuthState(state, catalog)).toThrow(
      InvalidRoomOAuthStateError,
    )
  })

  it('fails closed when a room is removed from the current catalogue', () => {
    const encoded = encodeRoomOAuthState({
      roomId: room.id,
      boundary: room.boundary,
      redirectTo: 'https://clubhouse.example/',
    })
    const removedCatalog = buildRoomCatalog([])

    expect(() => decodeRoomOAuthState(encoded, removedCatalog)).toThrow(
      InvalidRoomOAuthStateError,
    )
  })

  it('fails closed when a catalogue entry changes boundary', () => {
    const encoded = encodeRoomOAuthState({
      roomId: room.id,
      boundary: room.boundary,
      redirectTo: 'https://clubhouse.example/',
    })
    const changedCatalog = buildRoomCatalog([
      { ...room, boundary: 'did:web:stratos.example/changed' },
    ])

    expect(() => decodeRoomOAuthState(encoded, changedCatalog)).toThrow(
      InvalidRoomOAuthStateError,
    )
  })

  it('fails closed when a room becomes unavailable after authorization', () => {
    const encoded = encodeRoomOAuthState({
      roomId: room.id,
      boundary: room.boundary,
      redirectTo: 'https://clubhouse.example/',
    })
    const unavailableCatalog = buildRoomCatalog([{ ...room, available: false }])

    expect(() => decodeRoomOAuthState(encoded, unavailableCatalog)).toThrow(
      InvalidRoomOAuthStateError,
    )
  })
})
