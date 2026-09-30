import { describe, it, expect, vi } from 'vitest'
import {
  fetchRepoPublicPosts,
  fetchPublicPosts,
  fetchStratosPosts,
  fetchAppviewStratosPosts,
  fetchFeedgenPosts,
  findPost,
  type FeedPost,
} from '../src/lib/feed'
import type { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

const createPost = (overrides: Partial<FeedPost> = {}): FeedPost => ({
  uri: 'at://did:plc:user1/app.bsky.feed.post/1',
  cid: 'cid1',
  text: 'Hello',
  createdAt: '2024-01-01T12:00:00.000Z',
  isPrivate: false,
  author: 'did:plc:user1',
  authorHandle: 'user1.test',
  boundaries: [],
  reply: null,
  ...overrides,
})

describe('feed extended logic', () => {
  describe('fetchRepoPublicPosts', () => {
    it('fetches and maps public posts correctly', async () => {
      const mockAgent = {
        com: {
          atproto: {
            repo: {
              listRecords: vi.fn().mockResolvedValue({
                data: {
                  records: [
                    {
                      uri: 'at://did:plc:user1/app.bsky.feed.post/1',
                      cid: 'cid1',
                      value: {
                        text: 'Hello World',
                        createdAt: '2024-01-01T12:00:00Z',
                      },
                    },
                  ],
                },
              }),
            },
          },
        },
      } as unknown as Agent

      const posts = await fetchRepoPublicPosts(mockAgent, 'did:plc:user1')
      expect(posts.length).toBe(1)
      expect(posts[0].text).toBe('Hello World')
      expect(posts[0].isPrivate).toBe(false)
      expect(mockAgent.com.atproto.repo.listRecords).toHaveBeenCalledWith({
        repo: 'did:plc:user1',
        collection: 'app.bsky.feed.post',
        limit: 50,
      })
    })

    it('returns empty array on error', async () => {
      const mockAgent = {
        com: {
          atproto: {
            repo: {
              listRecords: vi.fn().mockRejectedValue(new Error('Fetch failed')),
            },
          },
        },
      } as unknown as Agent

      const posts = await fetchRepoPublicPosts(mockAgent, 'did:plc:user1')
      expect(posts).toEqual([])
    })
  })

  describe('fetchPublicPosts', () => {
    it('fetches and maps author feed posts correctly', async () => {
      const mockAgent = {
        app: {
          bsky: {
            feed: {
              getAuthorFeed: vi.fn().mockResolvedValue({
                data: {
                  feed: [
                    {
                      post: {
                        uri: 'at://did:plc:user1/app.bsky.feed.post/1',
                        cid: 'cid1',
                        record: {
                          text: 'Public Post',
                          createdAt: '2024-01-01T12:00:00Z',
                        },
                        author: {
                          did: 'did:plc:user1',
                          handle: 'user1.test',
                        },
                      },
                    },
                  ],
                },
              }),
            },
          },
        },
      } as unknown as Agent

      const posts = await fetchPublicPosts(mockAgent, 'did:plc:user1')
      expect(posts.length).toBe(1)
      expect(posts[0].text).toBe('Public Post')
      expect(posts[0].authorHandle).toBe('user1.test')
      expect(mockAgent.app.bsky.feed.getAuthorFeed).toHaveBeenCalledWith({
        actor: 'did:plc:user1',
        filter: 'posts_with_replies',
        limit: 50,
      })
    })

    it('returns empty array on error', async () => {
      const mockAgent = {
        app: {
          bsky: {
            feed: {
              getAuthorFeed: vi
                .fn()
                .mockRejectedValue(new Error('Fetch failed')),
            },
          },
        },
      } as unknown as Agent

      const posts = await fetchPublicPosts(mockAgent, 'did:plc:user1')
      expect(posts).toEqual([])
    })
  })

  describe('fetchStratosPosts', () => {
    it('fetches and maps stratos posts correctly', async () => {
      const mockAgent = {
        com: {
          atproto: {
            repo: {
              listRecords: vi.fn().mockResolvedValue({
                data: {
                  records: [
                    {
                      uri: 'at://did:plc:user1/zone.stratos.feed.post/1',
                      cid: 'cid1',
                      value: {
                        text: 'Stratos Post',
                        createdAt: '2024-01-01T12:00:00Z',
                        boundary: {
                          values: [{ value: 'eng' }],
                        },
                      },
                    },
                  ],
                },
              }),
            },
          },
        },
      } as unknown as Agent

      const posts = await fetchStratosPosts(mockAgent, 'did:plc:user1')
      expect(posts.length).toBe(1)
      expect(posts[0].text).toBe('Stratos Post')
      expect(posts[0].isPrivate).toBe(true)
      expect(posts[0].boundaries).toEqual(['eng'])
      expect(mockAgent.com.atproto.repo.listRecords).toHaveBeenCalledWith({
        repo: 'did:plc:user1',
        collection: 'zone.stratos.feed.post',
        limit: 50,
      })
    })
  })

  describe('fetchAppviewStratosPosts', () => {
    it('fetches and maps appview stratos posts correctly', async () => {
      const mockSession = {
        fetchHandler: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            feed: [
              {
                post: {
                  uri: 'at://did:plc:user1/zone.stratos.feed.post/1',
                  cid: 'cid1',
                  record: {
                    text: 'Appview Post',
                    createdAt: '2024-01-01T12:00:00Z',
                    boundary: {
                      values: [{ value: 'leadership' }],
                    },
                  },
                  author: {
                    did: 'did:plc:user1',
                    handle: 'user1.test',
                  },
                },
              },
            ],
            cursor: 'next-cursor',
          }),
        }),
      } as unknown as OAuthSession

      const result = await fetchAppviewStratosPosts(
        mockSession,
        'https://appview.stratos.actor',
      )
      expect(result.posts.length).toBe(1)
      expect(result.posts[0].text).toBe('Appview Post')
      expect(result.posts[0].boundaries).toEqual(['leadership'])
      expect(result.cursor).toBe('next-cursor')
      expect(mockSession.fetchHandler).toHaveBeenCalledWith(
        expect.stringContaining('/xrpc/zone.stratos.feed.getTimeline'),
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('handles failure in fetchAppviewStratosPosts', async () => {
      const mockSession = {
        fetchHandler: vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        }),
      } as unknown as OAuthSession

      const result = await fetchAppviewStratosPosts(
        mockSession,
        'https://appview.stratos.actor',
      )
      expect(result.posts).toEqual([])
    })
  })

  describe('fetchFeedgenPosts', () => {
    it('uses feedgen boundaries for a PDS-custody post', async () => {
      const mockSession = {
        fetchHandler: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            feed: [
              {
                post: {
                  uri: 'at://did:web:section-9.test/space/zone.stratos.space.feed/section-9/did:plc:motoko/zone.stratos.feed.post/1',
                  cid: 'cid1',
                  record: {
                    text: 'Motoko posts from the PDS space.',
                    createdAt: '2024-01-01T12:00:00Z',
                  },
                  author: { did: 'did:plc:motoko' },
                  boundaries: ['section-9'],
                },
              },
            ],
          }),
        }),
      } as unknown as OAuthSession

      const result = await fetchFeedgenPosts(
        mockSession,
        'did:web:batou.test',
        'section-9',
      )

      if (!result.ok) throw new Error('Expected the private feed')
      expect(result.posts).toHaveLength(1)
      expect(result.posts[0]?.boundaries).toEqual(['section-9'])
      expect(mockSession.fetchHandler).toHaveBeenCalledWith(
        expect.stringContaining('/xrpc/zone.stratos.feedgen.getFeed'),
        expect.objectContaining({
          headers: {
            'atproto-proxy': 'did:web:batou.test#stratos_feedgen',
          },
          method: 'GET',
        }),
      )
    })

    it('distinguishes an authorized empty feed from FeedNotReady', async () => {
      const session = {
        fetchHandler: vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ feed: [] }), { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'FeedNotReady' }), {
              status: 503,
            }),
          ),
      } as unknown as OAuthSession

      expect(
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
      ).toEqual({
        ok: true,
        posts: [],
        cursor: undefined,
      })
      expect(
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
      ).toEqual({
        ok: false,
        posts: [],
        category: 'not-ready',
        status: 503,
        retryable: true,
      })
    })

    it('logs successful feed completion with structured context', async () => {
      const consoleInfo = vi
        .spyOn(console, 'info')
        .mockImplementation(() => undefined)
      try {
        const session = {
          fetchHandler: vi
            .fn()
            .mockResolvedValue(
              new Response(JSON.stringify({ feed: [] }), { status: 200 }),
            ),
        } as unknown as OAuthSession
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9')
        expect(consoleInfo).toHaveBeenCalledWith(
          { operation: 'feedgen.getFeed', postCount: 0 },
          'Feedgen feed request completed',
        )
      } finally {
        consoleInfo.mockRestore()
      }
    })

    it.each([401, 403])(
      'classifies %i as authorization loss without logging a response body',
      async (status) => {
        const secret = 'private upstream diagnostic'
        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => undefined)
        try {
          const session = {
            fetchHandler: vi
              .fn()
              .mockResolvedValue(
                new Response(
                  JSON.stringify({ error: 'ExpiredToken', message: secret }),
                  { status },
                ),
              ),
          } as unknown as OAuthSession
          expect(
            await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
          ).toEqual({
            ok: false,
            posts: [],
            category: 'authorization',
            status,
            retryable: false,
          })
          expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret)
          expect(consoleError).toHaveBeenCalledWith(
            {
              operation: 'feedgen.getFeed',
              status,
              category: 'authorization',
            },
            'Feedgen feed request failed',
          )
        } finally {
          consoleError.mockRestore()
        }
      },
    )

    it('distinguishes network and malformed successful responses', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      try {
        const session = {
          fetchHandler: vi
            .fn()
            .mockRejectedValueOnce(new Error('private token'))
            .mockResolvedValueOnce(new Response('{', { status: 200 }))
            .mockResolvedValueOnce(
              new Response(JSON.stringify({ posts: [] }), { status: 200 }),
            ),
        } as unknown as OAuthSession
        expect(
          await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
        ).toEqual({
          ok: false,
          posts: [],
          category: 'network',
          retryable: true,
        })
        expect(
          await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
        ).toEqual({
          ok: false,
          posts: [],
          category: 'malformed',
          status: 200,
          retryable: true,
        })
        expect(
          await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
        ).toEqual({
          ok: false,
          posts: [],
          category: 'malformed',
          status: 200,
          retryable: true,
        })
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
          'private token',
        )
      } finally {
        consoleError.mockRestore()
      }
    })

    it.each([
      [500, 'unavailable', true],
      [503, 'unavailable', true],
      [429, 'unavailable', true],
      [400, 'unavailable', false],
    ] as const)(
      'preserves HTTP %i failure category and retryability',
      async (status, category, retryable) => {
        const session = {
          fetchHandler: vi
            .fn()
            .mockResolvedValue(new Response(null, { status })),
        } as unknown as OAuthSession
        expect(
          await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
        ).toEqual({
          ok: false,
          posts: [],
          category,
          status,
          retryable,
        })
      },
    )

    it.each([
      null,
      [],
      {},
      { feed: null },
      { feed: [null] },
      { feed: [{ post: null }] },
      { feed: [{ post: 7 }] },
      {
        feed: [
          {
            post: {
              cid: 'cid',
              record: { text: 'hi', createdAt: '1995-01-01' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 7,
              cid: 'cid',
              record: { text: 'hi', createdAt: '1995-01-01' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              record: { text: 'hi', createdAt: '1995-01-01' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 7,
              record: { text: 'hi', createdAt: '1995-01-01' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: 7,
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: { createdAt: '1995-01-01' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: { text: 7, createdAt: '1995-01-01' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: { text: 'hi' },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: { text: 'hi', createdAt: 7 },
            },
          },
        ],
      },
      {
        feed: [
          { post: { uri: 'at://did:plc:motoko/zone.stratos.feed.post/1' } },
        ],
      },
      { feed: [], cursor: 5 },
      { feed: [], cursor: null },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: {
                text: 'hi',
                createdAt: '1995-01-01',
                embed: { $type: 'app.bsky.embed.images', images: {} },
              },
            },
          },
        ],
      },
      {
        feed: [
          {
            post: {
              uri: 'at://did:plc:motoko/app.bsky.feed.post/1',
              cid: 'cid',
              record: {
                text: 'hi',
                createdAt: '1995-01-01',
                embed: {
                  $type: 'app.bsky.embed.recordWithMedia',
                  media: {
                    $type: 'app.bsky.embed.images',
                    images: {},
                  },
                },
              },
            },
          },
        ],
      },
    ])('rejects malformed successful feed shape %#', async (body) => {
      const session = {
        fetchHandler: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(body), { status: 200 }),
          ),
      } as unknown as OAuthSession
      expect(
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
      ).toEqual({
        ok: false,
        posts: [],
        category: 'malformed',
        status: 200,
        retryable: true,
      })
    })

    it('bounds upstream error reading and keeps its contents out of logs', async () => {
      const secret = 'sensitive token'
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      try {
        const session = {
          fetchHandler: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                error: 'FeedNotReady',
                message: secret.repeat(1000),
              }),
              { status: 503 },
            ),
          ),
        } as unknown as OAuthSession
        const result = await fetchFeedgenPosts(
          session,
          'did:web:batou.test',
          'section-9',
        )
        expect(result).toMatchObject({
          ok: false,
          category: 'unavailable',
          retryable: true,
        })
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret)
      } finally {
        consoleError.mockRestore()
      }
    })

    it('recognizes FeedNotReady even on a nonstandard HTTP status', async () => {
      const session = {
        fetchHandler: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'FeedNotReady' }), {
            status: 400,
          }),
        ),
      } as unknown as OAuthSession
      expect(
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
      ).toEqual({
        ok: false,
        posts: [],
        category: 'not-ready',
        status: 400,
        retryable: true,
      })
    })

    it.each([{ error: null }, { error: 7 }, [], null])(
      'ignores non-string upstream error codes %#',
      async (body) => {
        const session = {
          fetchHandler: vi
            .fn()
            .mockResolvedValue(
              new Response(JSON.stringify(body), { status: 503 }),
            ),
        } as unknown as OAuthSession
        expect(
          await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
        ).toMatchObject({
          ok: false,
          category: 'unavailable',
          retryable: true,
        })
      },
    )

    it('parses a chunked error code', async () => {
      const encoded = new TextEncoder().encode(
        JSON.stringify({ error: 'FeedNotReady' }),
      )
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.subarray(0, 8))
            controller.enqueue(encoded.subarray(8))
            controller.close()
          },
        }),
        { status: 503 },
      )
      const session = {
        fetchHandler: vi.fn().mockResolvedValue(response),
      } as unknown as OAuthSession
      expect(
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
      ).toMatchObject({
        ok: false,
        category: 'not-ready',
        retryable: true,
      })
    })

    it('cancels an oversized upstream error stream', async () => {
      let cancelled = false
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(5000)))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 503 },
      )
      const session = {
        fetchHandler: vi.fn().mockResolvedValue(response),
      } as unknown as OAuthSession
      expect(
        await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9'),
      ).toMatchObject({
        ok: false,
        category: 'unavailable',
        retryable: true,
      })
      expect(cancelled).toBe(true)
    })

    it('stops reading when an upstream error reaches the byte limit', async () => {
      let cancelled = false
      let timeout: ReturnType<typeof setTimeout>
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4096).fill(120))
            timeout = setTimeout(() => controller.close(), 250)
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 503 },
      )
      const session = {
        fetchHandler: vi.fn().mockResolvedValue(response),
      } as unknown as OAuthSession
      await fetchFeedgenPosts(session, 'did:web:batou.test', 'section-9')
      clearTimeout(timeout!)
      expect(cancelled).toBe(true)
    })

    it('returns a valid cursor and uses a supplied cursor in the request', async () => {
      const session = {
        fetchHandler: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ feed: [], cursor: 'next-page' }), {
            status: 200,
          }),
        ),
      } as unknown as OAuthSession
      expect(
        await fetchFeedgenPosts(
          session,
          'did:web:batou.test',
          'section-9',
          'previous-page',
        ),
      ).toEqual({
        ok: true,
        posts: [],
        cursor: 'next-page',
      })
      expect(session.fetchHandler).toHaveBeenCalledWith(
        expect.stringContaining('cursor=previous-page'),
        expect.objectContaining({ method: 'GET' }),
      )
    })
  })

  describe('findPost', () => {
    it('finds a post by its URI', () => {
      const p1 = createPost({ uri: 'at://1' })
      const p2 = createPost({ uri: 'at://2' })
      const posts = [p1, p2]

      expect(findPost(posts, 'at://1')).toBe(p1)
      expect(findPost(posts, 'at://2')).toBe(p2)
      expect(findPost(posts, 'at://3')).toBeUndefined()
    })
  })
})
