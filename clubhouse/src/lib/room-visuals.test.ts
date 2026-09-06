import { describe, expect, it } from 'vitest'
import { roomVisualsFor } from './room-visuals'
import type { RoomCatalogEntry } from './types'

function room(id: string, displayName: string): RoomCatalogEntry {
  return {
    id,
    displayName,
    description: `${displayName} room`,
    available: true,
  }
}

describe('roomVisualsFor', () => {
  it('gives rooms distinct icons and colors', () => {
    const visuals = roomVisualsFor([
      room('bebop', 'Music room'),
      room('nerv-hq', 'Project room'),
      room('after-school', 'Study room'),
    ])

    expect(new Set([...visuals.values()].map(({ icon }) => icon)).size).toBe(3)
    expect(new Set([...visuals.values()].map(({ tone }) => tone)).size).toBe(3)
  })

  it('keeps every icon distinct across the full visual palette', () => {
    const rooms = [
      'bebop',
      'nerv',
      'tomobiki',
      'furinkan',
      'shohoku',
      'neo-tokyo',
      'juraian',
      'dominion',
      'ohtori',
      'onizuka',
      'mugen',
      'trigun',
    ].map((id) => room(id, `Gathering ${id}`))
    const visuals = [...roomVisualsFor(rooms).values()]

    expect(new Set(visuals.map(({ icon }) => icon)).size).toBe(rooms.length)
  })

  it('keeps assignments stable when catalogue order changes', () => {
    const rooms = [
      room('bebop', 'Music room'),
      room('nerv-hq', 'Project room'),
      room('after-school', 'Study room'),
    ]

    expect([...roomVisualsFor(rooms)]).toEqual([
      ...roomVisualsFor([...rooms].reverse()),
    ])
  })

  it('uses the music treatment for listening rooms', () => {
    const visuals = roomVisualsFor([
      room('film-club', 'The late screening'),
      room('yoko-record-club', 'After-hours listening'),
    ])

    expect(visuals.get('film-club')).toEqual({ icon: 'camera', tone: 'sky' })
    expect(visuals.get('yoko-record-club')).toEqual({
      icon: 'music',
      tone: 'magenta',
    })
  })
})
