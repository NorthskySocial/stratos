import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import Feed from '../src/lib/Feed.svelte'
import PostCard from '../src/lib/PostCard.svelte'
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

describe('feedgen private image transport', () => {
  const uri = 'at://did:plc:misato/zone.stratos.feed.post/image'
  const cid = 'bafkreidnltm3txbyqufe7hbtf4b5gasd2jwyfo5qgzyg2nbkfspzvj5mxa'
  function payload(blobs?: { cid: string; url: string }[]) {
    return {
      feed: [
        {
          post: {
            uri,
            cid,
            author: { did: 'did:plc:misato' },
            indexedAt: '1998-04-03T00:00:00.000Z',
            blobs,
            record: {
              $type: 'zone.stratos.feed.post',
              text: 'Misato sends a photo.',
              createdAt: '1998-04-03T00:00:00.000Z',
              embed: {
                $type: 'app.bsky.embed.images',
                images: [
                  {
                    alt: 'Bebop crew',
                    image: {
                      $type: 'blob',
                      ref: { $link: cid },
                      mimeType: 'image/png',
                      size: 5,
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    }
  }
  it('fetches bytes through the PDS proxy, never through a supplied URL', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            payload([
              { cid: 'other-cid', url: 'https://untrusted.test/other' },
              { cid, url: 'https://untrusted.test/steal' },
            ]),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response('Spike', { headers: { 'content-type': 'image/png' } }),
      )
    const { posts } = await fetchFeedgenPosts(
      { fetchHandler } as unknown as OAuthSession,
      'did:web:feedgen.test',
      'bebop',
    )
    const image = await posts[0].loadFeedgenBlob?.(cid)
    expect(await image?.text()).toBe('Spike')
    expect(image?.type).toBe('image/png')
    expect(fetchHandler).toHaveBeenLastCalledWith(
      `/xrpc/zone.stratos.feedgen.getBlob?${new URLSearchParams({ uri, cid })}`,
      {
        method: 'GET',
        headers: { 'atproto-proxy': 'did:web:feedgen.test#stratos_feedgen' },
      },
    )
    expect(await posts[0].loadFeedgenBlob?.('different-cid')).toBeUndefined()
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })
  it('keeps direct private reads available when no blob view is supplied', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(payload())))
    const { posts } = await fetchFeedgenPosts(
      { fetchHandler } as unknown as OAuthSession,
      'did:web:feedgen.test',
      'bebop',
    )
    expect(await posts[0].loadFeedgenBlob?.(cid)).toBeUndefined()
    expect(fetchHandler).toHaveBeenCalledOnce()
    expect(posts[0].embed?.images?.[0].image.ref?.$link).toBe(cid)
  })
  it('keeps a denied feedgen read closed without silently falling back', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(payload([{ cid, url: 'https://feedgen.test/blob' }])),
        ),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    const { posts } = await fetchFeedgenPosts(
      { fetchHandler } as unknown as OAuthSession,
      'did:web:feedgen.test',
      'bebop',
    )
    await expect(posts[0].loadFeedgenBlob?.(cid)).rejects.toThrow(
      'Private image is unavailable',
    )
  })
  it('renders authenticated bytes as a local object URL and revokes it on removal', async () => {
    const create = vi.fn(() => 'blob:https://webapp.test/misato')
    const revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
    )
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(payload([{ cid, url: 'https://feedgen.test/blob' }])),
        ),
      )
      .mockResolvedValueOnce(
        new Response('Spike', { headers: { 'content-type': 'image/png' } }),
      )
    const { posts } = await fetchFeedgenPosts(
      { fetchHandler } as unknown as OAuthSession,
      'did:web:feedgen.test',
      'bebop',
    )
    const rendered = render(PostCard, {
      props: {
        post: posts[0],
        stratosAgent: null,
        currentDid: 'did:plc:shinji',
        onreply: vi.fn(),
        ondelete: vi.fn(),
      },
    })
    await waitFor(() =>
      expect(screen.getByAltText('Bebop crew')).toHaveAttribute(
        'src',
        'blob:https://webapp.test/misato',
      ),
    )
    expect(create).toHaveBeenCalledOnce()
    rendered.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://webapp.test/misato')
    vi.unstubAllGlobals()
  })
  it('discards image responses arriving after the post is removed', async () => {
    const create = vi.fn()
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
    )
    const fetchHandler = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(payload([{ cid, url: 'https://feedgen.test/blob' }])),
        ),
      )
    const { posts } = await fetchFeedgenPosts(
      { fetchHandler } as unknown as OAuthSession,
      'did:web:feedgen.test',
      'bebop',
    )
    let release!: (blob: Blob) => void
    const load = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          release = resolve
        }),
    )
    posts[0].loadFeedgenBlob = load
    const rendered = render(PostCard, {
      props: {
        post: posts[0],
        stratosAgent: null,
        currentDid: 'did:plc:shinji',
        onreply: vi.fn(),
        ondelete: vi.fn(),
      },
    })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    rendered.unmount()
    release(new Blob(['Spike'], { type: 'image/png' }))
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
