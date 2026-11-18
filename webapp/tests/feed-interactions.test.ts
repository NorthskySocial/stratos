import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { fetchFeedgenPosts } from '../src/lib/feed'

function feedgenSession(post: Record<string, unknown>) {
  return {
    fetchHandler: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:kaji/zone.stratos.feed.post/3kwatermelon',
                cid: 'bafyreikaji',
                author: { did: 'did:plc:kaji', handle: 'kaji.example' },
                record: {
                  text: 'Watermelons',
                  createdAt: '1995-10-04T00:00:00Z',
                },
                indexedAt: '1995-10-04T00:00:00Z',
                boundaries: ['did:web:stratos.example/nerve'],
                ...post,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  } as unknown as OAuthSession
}

describe('fetchFeedgenPosts interaction fields', () => {
  afterEach(() => vi.restoreAllMocks())

  it('carries likeCount and the viewer like and repost from the feed generator', async () => {
    const result = await fetchFeedgenPosts(
      feedgenSession({
        likeCount: 3,
        repostCount: 1,
        viewer: {
          like: 'at://did:plc:shinji/app.bsky.feed.like/3kunit01',
        },
      }),
      'did:web:feedgen.example',
      'nerve',
    )

    expect(result.ok).toBe(true)
    expect(result.posts[0]).toMatchObject({
      likeCount: 3,
      viewer: { like: 'at://did:plc:shinji/app.bsky.feed.like/3kunit01' },
    })
  })

  it('leaves the fields off a post that carries none', async () => {
    const result = await fetchFeedgenPosts(
      feedgenSession({}),
      'did:web:feedgen.example',
      'nerve',
    )

    expect(result.posts[0]).not.toHaveProperty('likeCount')
    expect(result.posts[0]).not.toHaveProperty('viewer')
  })
})
