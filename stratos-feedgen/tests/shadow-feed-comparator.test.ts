import { describe, expect, it } from 'vitest'
import {
  compareShadowFeedDecisions,
  type ShadowFeedDecision,
} from '../src/shadow/feed-comparator.js'

const primary: ShadowFeedDecision = {
  status: 200,
  cursor: 'private-cursor',
  postIdentifiers: ['at://post/one#cid-one', 'at://post/two#cid-two'],
}

describe('feed read shadow comparator', () => {
  it('accepts identical decisions without exposing response fields', () => {
    expect(compareShadowFeedDecisions(primary, { ...primary })).toEqual({
      matched: true,
    })
  })

  it.each([
    ['status', { ...primary, status: 503 }],
    ['error', { ...primary, error: 'FeedNotReady' }],
    ['cursor', { ...primary, cursor: 'other-private-cursor' }],
    ['post-count', { ...primary, postIdentifiers: ['at://post/one#cid-one'] }],
    [
      'post-order',
      {
        ...primary,
        postIdentifiers: ['at://post/one#cid-one', 'at://post/other#cid-other'],
      },
    ],
  ] satisfies readonly [string, ShadowFeedDecision][])(
    'reports only the bounded %s mismatch category',
    (reason, shadow) => {
      const result = compareShadowFeedDecisions(primary, shadow)

      expect(result).toEqual({ matched: false, reason })
      expect(JSON.stringify(result)).not.toContain('private')
      expect(JSON.stringify(result)).not.toContain('at://')
    },
  )
})
