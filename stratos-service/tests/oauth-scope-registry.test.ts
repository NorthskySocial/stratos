import { describe, expect, it } from 'vitest'
import { buildOAuthScope, buildSpaceScope } from '../src/oauth/client.js'
import { HOSTED_SPACE_COLLECTIONS } from '../src/shared/space-type-registry.js'

describe('space scope built from the registry', () => {
  it('requests every hosted collection in registry order', () => {
    const scope = buildSpaceScope('did:web:tokyo-3.example')
    const query = scope.slice(scope.indexOf('?') + 1)
    const requested = new URLSearchParams(query).getAll('collection')
    expect(requested).toEqual([...HOSTED_SPACE_COLLECTIONS])
  })

  it('keeps the enrolment scope byte-identical to the baseline', () => {
    expect(buildOAuthScope('did:web:tokyo-3.example')).toBe(
      'atproto repo:zone.stratos.actor.enrollment space:zone.stratos.space.feed?authority=did%3Aweb%3Atokyo-3.example&collection=zone.stratos.feed.post&collection=app.bsky.feed.like&collection=app.bsky.feed.repost&action=create&action=read',
    )
  })
})
