import { describe, expect, it } from 'vitest'
import {
  consumeRoomJoin,
  consumeRoomReturn,
  rememberRoomJoin,
  rememberRoomReturn,
  roomJoinUrl,
} from './join'

describe('room enrollment URL', () => {
  it('submits only a room ID with the approved callback and client metadata', () => {
    const url = roomJoinUrl(
      {
        serviceUrl: 'https://stratos.example',
        publicOrigin: 'https://clubhouse.example',
        pdsSpaceUriByRoom: {},
      },
      'nerv-hq',
      'misato.example',
      '/rooms/nerv-hq',
    )
    expect(url.href).toContain('https://stratos.example/oauth/authorize?')
    expect(url.searchParams.get('room')).toBe('nerv-hq')
    expect(url.searchParams.get('handle')).toBe('misato.example')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://clubhouse.example/',
    )
    expect(url.searchParams.get('client_id')).toBe(
      'https://clubhouse.example/client-metadata.json',
    )
    expect(url.href).not.toContain('boundary')
  })

  it('rejects a return target outside a room route', () => {
    expect(() =>
      roomJoinUrl(
        { serviceUrl: 'https://stratos.example', pdsSpaceUriByRoom: {} },
        'nerv-hq',
        'misato.example',
        'https://elsewhere.example',
      ),
    ).toThrow('return path')
  })

  it('preserves only a public room route across the callback', () => {
    rememberRoomReturn('/rooms/terminal-dogma')
    expect(consumeRoomReturn()).toBe('/rooms/terminal-dogma')
    expect(consumeRoomReturn()).toBeNull()
  })

  it('keeps a public room choice across browser sign-in', () => {
    rememberRoomJoin('terminal-dogma')
    expect(consumeRoomJoin()).toBe('terminal-dogma')
    expect(consumeRoomJoin()).toBeNull()
  })
})
