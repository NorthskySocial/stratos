import { describe, expect, it } from 'vitest'
import {
  buildSpaceWriteScope,
  CLUBHOUSE_POST_SCOPE,
  CLUBHOUSE_SPACE_ACTIONS,
} from './auth'

describe('Clubhouse OAuth post permissions', () => {
  it('requests full repository access to the room post collection', () => {
    expect(CLUBHOUSE_POST_SCOPE).toBe('repo:zone.stratos.feed.post')
  })

  it('requests every supported space record action in canonical order', () => {
    expect(
      buildSpaceWriteScope({
        serviceDid: 'did:web:nerv.example',
        actions: CLUBHOUSE_SPACE_ACTIONS,
      }),
    ).toBe(
      'space:zone.stratos.space.feed?authority=did%3Aweb%3Anerv.example&collection=zone.stratos.feed.post&action=read&action=create&action=update&action=delete',
    )
  })
})
