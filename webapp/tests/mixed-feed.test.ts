import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import Feed from '../src/lib/Feed.svelte'
import { fetchFeedgenPosts } from '../src/lib/feed'

describe('Feed.svelte', () => {
  it('renders both custody classes with real authors from the feedgen path', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:misato/zone.stratos.feed.post/one',
                cid: 'misato-cid',
                author: { did: 'did:plc:misato' },
                indexedAt: '1998-04-03T00:00:00.000Z',
                record: {
                  $type: 'zone.stratos.feed.post',
                  text: 'Misato keeps the Stratos copy.',
                  createdAt: '1998-04-03T00:00:00.000Z',
                  boundary: {
                    $type: 'zone.stratos.boundary.defs#Domains',
                    values: [{ value: 'did:web:stratos.example/nerve' }],
                  },
                },
              },
            },
            {
              post: {
                uri: 'at://did:web:stratos.example/space/zone.stratos.space.feed/nerve/did:plc:asuka/zone.stratos.feed.post/two',
                cid: 'asuka-cid',
                author: { did: 'did:plc:asuka' },
                indexedAt: '1998-04-04T00:00:00.000Z',
                record: {
                  $type: 'zone.stratos.feed.post',
                  text: 'Asuka keeps the PDS copy.',
                  createdAt: '1998-04-04T00:00:00.000Z',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const session = {
      sub: 'did:plc:shinji',
      fetchHandler,
    } as unknown as OAuthSession

    const { posts } = await fetchFeedgenPosts(
      session,
      'did:web:feedgen.example',
      'nerve',
    )

    expect(fetchHandler).toHaveBeenCalledWith(
      '/xrpc/zone.stratos.feedgen.getFeed?feed=nerve&limit=50',
      {
        method: 'GET',
        headers: {
          'atproto-proxy': 'did:web:feedgen.example#stratos_feedgen',
        },
      },
    )
    expect(posts.map(({ author }) => author)).toEqual([
      'did:plc:misato',
      'did:plc:asuka',
    ])
    expect(posts).toMatchObject([
      {
        uri: 'at://did:plc:misato/zone.stratos.feed.post/one',
        isPrivate: true,
      },
      {
        uri: 'at://did:web:stratos.example/space/zone.stratos.space.feed/nerve/did:plc:asuka/zone.stratos.feed.post/two',
        isPrivate: true,
      },
    ])

    render(Feed, {
      props: {
        loading: false,
        stratosAgent: null,
        publicAgent: null,
        serviceUrl: 'https://stratos.example',
        onreply: vi.fn(),
        posts,
      },
    })

    expect(screen.getByText('@did:plc:misato')).toBeInTheDocument()
    expect(screen.getByText('@did:plc:asuka')).toBeInTheDocument()
    expect(
      screen.getByText('Misato keeps the Stratos copy.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Asuka keeps the PDS copy.')).toBeInTheDocument()
    expect(screen.getAllByText('Private')).toHaveLength(2)
  })
})
