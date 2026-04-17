import { describe, it, expect, vi } from 'vitest'
import {
  fetchRepoPublicPosts,
  fetchPublicPosts,
  fetchStratosPosts,
  fetchAppviewStratosPosts,
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
