import { describe, expect, it } from 'vitest'
import {
  HOSTED_SPACE_COLLECTIONS,
  HOSTED_SPACE_TYPE,
  SPACE_TYPE_REGISTRY,
} from '../src/shared/space-type-registry.js'

const FEED_SPACE = 'zone.stratos.space.feed'

describe('SPACE_TYPE_REGISTRY', () => {
  it('lists the feed space collections from the shipped declaration', () => {
    expect(SPACE_TYPE_REGISTRY.collections(FEED_SPACE)).toEqual([
      'zone.stratos.feed.post',
      'app.bsky.feed.like',
      'app.bsky.feed.repost',
    ])
  })

  it('allows a collection the feed space declares', () => {
    expect(
      SPACE_TYPE_REGISTRY.allowsCollection(
        FEED_SPACE,
        'zone.stratos.feed.post',
      ),
    ).toBe(true)
  })

  it('rejects a collection the feed space does not declare', () => {
    expect(
      SPACE_TYPE_REGISTRY.allowsCollection(
        FEED_SPACE,
        'zone.stratos.graph.follow',
      ),
    ).toBe(false)
  })
})

describe('HOSTED_SPACE_COLLECTIONS', () => {
  it('equals the registry collections for the hosted space type', () => {
    expect(HOSTED_SPACE_COLLECTIONS).toEqual(
      SPACE_TYPE_REGISTRY.collections(HOSTED_SPACE_TYPE),
    )
  })
})
