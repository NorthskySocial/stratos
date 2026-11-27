import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Lexicons } from '@atproto/lexicon'
import { stratosLexicons } from '@northskysocial/stratos-client/lexicons'

// The Rust feed generator writes and pins this file in its conformance tests.
// Validating it here keeps what it serves inside the published lexicon.
const FIXTURE_URL = new URL(
  '../../stratos-feedgen/testdata/conformance/v1/feed-view.json',
  import.meta.url,
)

interface FeedViewFixture {
  version: number
  output: { feed: Array<{ post: Record<string, unknown> }> }
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as FeedViewFixture
const lexicons = new Lexicons(stratosLexicons)

describe('the shared feed view fixture', () => {
  it('is a valid getFeed output', () => {
    expect(fixture.version).toBe(1)
    expect(() =>
      lexicons.assertValidXrpcOutput(
        'zone.stratos.feedgen.getFeed',
        fixture.output,
      ),
    ).not.toThrow()
  })

  it('carries the counts and the viewer state on every post', () => {
    expect(fixture.output.feed.length).toBeGreaterThan(0)
    for (const { post } of fixture.output.feed) {
      expect(post).toHaveProperty('likeCount')
      expect(post).toHaveProperty('repostCount')
      expect(post).toHaveProperty('viewer')
    }
  })

  it('rejects a count that is not an integer', () => {
    const broken = structuredClone(fixture.output)
    broken.feed[0].post.likeCount = '2'

    expect(() =>
      lexicons.assertValidXrpcOutput('zone.stratos.feedgen.getFeed', broken),
    ).toThrow()
  })

  it('rejects a viewer record that is not a string', () => {
    const broken = structuredClone(fixture.output)
    broken.feed[0].post.viewer = { like: 7 }

    expect(() =>
      lexicons.assertValidXrpcOutput('zone.stratos.feedgen.getFeed', broken),
    ).toThrow()
  })
})
