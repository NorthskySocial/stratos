import { describe, it, expect } from 'vitest'
import {
  buildUnifiedFeed,
  collectDomains,
  filterByDomain,
  feedStats,
  resolveHandles,
  groupIntoThreads,
  type FeedPost
} from '../src/lib/feed'

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

describe('feed logic', () => {
  describe('buildUnifiedFeed', () => {
    it('combines and sorts posts by date descending', () => {
      const p1 = createPost({ createdAt: '2024-01-01T10:00:00Z', uri: 'at://1' })
      const p2 = createPost({ createdAt: '2024-01-01T12:00:00Z', uri: 'at://2' })
      const p3 = createPost({ createdAt: '2024-01-01T11:00:00Z', uri: 'at://3' })

      const unified = buildUnifiedFeed([p1], [p2, p3])
      expect(unified.map(p => p.uri)).toEqual(['at://2', 'at://3', 'at://1'])
    })
  })

  describe('collectDomains', () => {
    it('collects unique boundaries from all posts and sorts them', () => {
      const p1 = createPost({ boundaries: ['eng', 'sales'] })
      const p2 = createPost({ boundaries: ['eng', 'hr'] })
      const p3 = createPost({ boundaries: [] })

      const domains = collectDomains([p1, p2, p3])
      expect(domains).toEqual(['eng', 'hr', 'sales'])
    })
  })

  describe('filterByDomain', () => {
    it('returns all posts if domain is null', () => {
      const posts = [createPost(), createPost()]
      expect(filterByDomain(posts, null)).toEqual(posts)
    })

    it('filters private posts by domain but keeps all public posts', () => {
      const publicPost = createPost({ isPrivate: false, boundaries: ['other'] })
      const privatePostEng = createPost({ isPrivate: true, boundaries: ['eng'] })
      const privatePostHr = createPost({ isPrivate: true, boundaries: ['hr'] })

      const filtered = filterByDomain([publicPost, privatePostEng, privatePostHr], 'eng')
      expect(filtered).toContain(publicPost)
      expect(filtered).toContain(privatePostEng)
      expect(filtered).not.toContain(privatePostHr)
    })
  })

  describe('feedStats', () => {
    it('calculates post and user counts', () => {
      const p1 = createPost({ author: 'user1' })
      const p2 = createPost({ author: 'user1' })
      const p3 = createPost({ author: 'user2' })

      const stats = feedStats([p1, p2, p3])
      expect(stats).toEqual({ postCount: 3, userCount: 2 })
    })
  })

  describe('resolveHandles', () => {
    it('updates authorHandle if missing and author matches currentDid', () => {
      const p1 = createPost({ author: 'did:me', authorHandle: '' })
      const p2 = createPost({ author: 'did:other', authorHandle: '' })

      const resolved = resolveHandles([p1, p2], 'did:me', 'me.test')
      expect(resolved[0].authorHandle).toBe('me.test')
      expect(resolved[1].authorHandle).toBe('')
    })

    it('does not overwrite existing authorHandle', () => {
      const p1 = createPost({ author: 'did:me', authorHandle: 'already.set' })
      const resolved = resolveHandles([p1], 'did:me', 'me.test')
      expect(resolved[0].authorHandle).toBe('already.set')
    })
  })

  describe('groupIntoThreads', () => {
    it('groups posts into tree structure based on replies', () => {
      const root = createPost({ uri: 'at://root', cid: 'c1' })
      const reply1 = createPost({
        uri: 'at://reply1',
        reply: { root: { uri: 'at://root', cid: 'c1' }, parent: { uri: 'at://root', cid: 'c1' } },
        createdAt: '2024-01-01T12:01:00Z'
      })
      const reply2 = createPost({
        uri: 'at://reply2',
        reply: { root: { uri: 'at://root', cid: 'c1' }, parent: { uri: 'at://root', cid: 'c1' } },
        createdAt: '2024-01-01T12:02:00Z'
      })
      const subReply = createPost({
        uri: 'at://subreply',
        reply: { root: { uri: 'at://root', cid: 'c1' }, parent: { uri: 'at://reply1', cid: 'c1' } }
      })

      const threads = groupIntoThreads([root, reply1, reply2, subReply])

      expect(threads.length).toBe(1)
      expect(threads[0].post.uri).toBe('at://root')
      expect(threads[0].replies.length).toBe(2)
      expect(threads[0].replies[0].post.uri).toBe('at://reply1')
      expect(threads[0].replies[1].post.uri).toBe('at://reply2')
      expect(threads[0].replies[0].replies.length).toBe(1)
      expect(threads[0].replies[0].replies[0].post.uri).toBe('at://subreply')
    })

    it('treats posts with missing parents as root posts', () => {
        const orphan = createPost({
            uri: 'at://orphan',
            reply: { root: { uri: 'at://missing', cid: 'x' }, parent: { uri: 'at://missing', cid: 'x' } }
        })
        const threads = groupIntoThreads([orphan])
        expect(threads.length).toBe(1)
        expect(threads[0].post.uri).toBe('at://orphan')
    })
  })
})
