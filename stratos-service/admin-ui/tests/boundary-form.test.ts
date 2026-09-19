import { describe, expect, it } from 'vitest'
import {
  boundarySettings,
  editBoundaryDraft,
  newBoundaryDraft,
} from '../src/lib/boundary-form'
import type { BoundaryDetails } from '../src/lib/api/boundary-catalog'

export const pilots: BoundaryDetails = {
  boundary: 'did:web:nerv.test/pilots',
  roomId: 'pilots',
  displayName: 'Pilots',
  description: 'Tokyo-3 pilots',
  listed: true,
  joinable: true,
  autoEnroll: true,
  appAccess: 'allowList',
  clientIds: ['https://eva.test/client', 'https://nerv.test/client'],
  status: 'active',
  revision: 3,
  memberCount: 2,
  reserved: false,
  createdAt: '1995-10-04T00:00:00Z',
  updatedAt: '1995-10-04T00:00:00Z',
}

describe('boundary form values', () => {
  it('starts with private, admin-managed membership and independent values', () => {
    expect(newBoundaryDraft()).toEqual({
      name: '',
      displayName: '',
      description: '',
      listed: false,
      joinable: false,
      autoEnroll: false,
      appAccess: 'open',
      clientIdsText: '',
    })
    const first = newBoundaryDraft()
    first.name = 'bebop'
    expect(newBoundaryDraft().name).toBe('')
  })
  it('round-trips editable settings without copying identity or member metadata', () => {
    const draft = editBoundaryDraft(pilots)
    expect(draft).toEqual({
      name: 'pilots',
      displayName: 'Pilots',
      description: 'Tokyo-3 pilots',
      listed: true,
      joinable: true,
      autoEnroll: true,
      appAccess: 'allowList',
      clientIdsText: 'https://eva.test/client\nhttps://nerv.test/client',
    })
    expect(boundarySettings(draft)).toEqual({
      displayName: 'Pilots',
      description: 'Tokyo-3 pilots',
      listed: true,
      joinable: true,
      autoEnroll: true,
      appAccess: 'allowList',
      clientIds: pilots.clientIds,
    })
    draft.name = 'changed'
    draft.description = 'changed'
    expect(pilots.roomId).toBe('pilots')
    expect(pilots.description).toBe('Tokyo-3 pilots')
  })
  it('normalizes client ID lines and name padding while preserving description formatting', () => {
    const draft = {
      ...newBoundaryDraft(),
      displayName: '  Bebop  ',
      description: '  See you\nspace cowboy  ',
      appAccess: 'allowList' as const,
      clientIdsText:
        '\n https://spike.test/client \r\n\n https://faye.test/client\n  ',
    }
    expect(boundarySettings(draft)).toEqual({
      displayName: 'Bebop',
      description: '  See you\nspace cowboy  ',
      listed: false,
      joinable: false,
      autoEnroll: false,
      appAccess: 'allowList',
      clientIds: ['https://spike.test/client', 'https://faye.test/client'],
    })
  })
  it('does not submit hidden client restrictions after switching to open app access', () => {
    const draft = { ...editBoundaryDraft(pilots), appAccess: 'open' as const }
    expect(boundarySettings(draft).clientIds).toEqual([])
    expect(draft.clientIdsText).toBe(
      'https://eva.test/client\nhttps://nerv.test/client',
    )
  })
})
