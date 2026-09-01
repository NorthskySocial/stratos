import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  EnrolledActorUpsert,
  FeedgenStore,
  PostUpsert,
} from '../../src/db/index.js'
import { decodeCursor, encodeCursor } from '../../src/db/index.js'

export interface StoreFactory {
  build: () => Promise<FeedgenStore>
}

const SPIKE_DID = 'did:plc:spikespiegel'
const FAYE_DID = 'did:plc:fayevalentine'
const VASH_DID = 'did:plc:vashstampede'
const SHINJI_DID = 'did:plc:shinjiikari'

function makePost(overrides: Partial<PostUpsert> = {}): PostUpsert {
  return {
    uri: `at://${SPIKE_DID}/zone.stratos.feed.post/1`,
    did: SPIKE_DID,
    cid: 'bafyabc',
    sortAt: '2024-01-01T00:00:00.000Z',
    indexedAt: '2024-01-01T00:00:00.000Z',
    record: { text: 'See you, space cowboy.' },
    blobRefs: [],
    boundaries: ['bounty-hunters'],
    ...overrides,
  }
}

function makeActor(
  overrides: Partial<EnrolledActorUpsert> = {},
): EnrolledActorUpsert {
  return {
    did: SPIKE_DID,
    boundaries: ['bounty-hunters'],
    enrolledAt: '2024-01-01T00:00:00.000Z',
    lastSeenAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function describeStoreContract(
  label: string,
  factory: StoreFactory,
): void {
  describe(`FeedgenStore contract (${label})`, () => {
    let store: FeedgenStore

    beforeEach(async () => {
      store = await factory.build()
    })

    afterEach(async () => {
      await store.close()
    })

    describe('cursor encoding', () => {
      it('round-trips', () => {
        const c = encodeCursor('2024-01-01T00:00:00.000Z', 'at://x/y/z')
        expect(decodeCursor(c)).toEqual({
          sortAt: '2024-01-01T00:00:00.000Z',
          uri: 'at://x/y/z',
        })
      })

      it('returns null on malformed cursor', () => {
        expect(decodeCursor('bogus')).toBeNull()
      })
    })

    describe('posts', () => {
      it('upserts a new post with boundaries', async () => {
        const p = makePost()
        await store.upsertPost(p)
        const fetched = await store.getPost(p.uri)
        expect(fetched).not.toBeNull()
        expect(fetched!.uri).toBe(p.uri)
        expect(fetched!.record).toEqual(p.record)
        expect(fetched!.boundaries.sort()).toEqual(p.boundaries.slice().sort())
      })

      it('returns null for unknown post', async () => {
        expect(await store.getPost('at://nope/zone.x/1')).toBeNull()
      })

      it('updates an existing post and replaces its boundaries', async () => {
        const p = makePost({ boundaries: ['old-a', 'old-b'] })
        await store.upsertPost(p)
        await store.upsertPost({
          ...p,
          record: { text: 'updated' },
          boundaries: ['new-a'],
        })
        const fetched = await store.getPost(p.uri)
        expect(fetched!.record).toEqual({ text: 'updated' })
        expect(fetched!.boundaries).toEqual(['new-a'])
      })

      it('deleting a post cascades to boundaries', async () => {
        const p = makePost({ boundaries: ['x', 'y'] })
        await store.upsertPost(p)
        await store.deletePost(p.uri)
        expect(await store.getPost(p.uri)).toBeNull()
        const empty = await store.listPostsByBoundary({
          boundary: 'x',
          limit: 10,
        })
        expect(empty.posts).toEqual([])
      })

      it('supports posts with no boundaries', async () => {
        const p = makePost({ boundaries: [] })
        await store.upsertPost(p)
        const fetched = await store.getPost(p.uri)
        expect(fetched!.boundaries).toEqual([])
      })
    })

    describe('listPostsByBoundary', () => {
      it('returns posts in DESC sortAt order with stable URI tiebreak', async () => {
        await store.upsertPost(
          makePost({
            uri: `at://${SPIKE_DID}/p/1`,
            sortAt: '2024-01-01T00:00:00.000Z',
            boundaries: ['feed'],
          }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${FAYE_DID}/p/2`,
            did: FAYE_DID,
            sortAt: '2024-01-03T00:00:00.000Z',
            boundaries: ['feed'],
          }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${VASH_DID}/p/3`,
            did: VASH_DID,
            sortAt: '2024-01-02T00:00:00.000Z',
            boundaries: ['feed'],
          }),
        )
        const res = await store.listPostsByBoundary({
          boundary: 'feed',
          limit: 10,
        })
        expect(res.posts.map((p) => p.uri)).toEqual([
          `at://${FAYE_DID}/p/2`,
          `at://${VASH_DID}/p/3`,
          `at://${SPIKE_DID}/p/1`,
        ])
        expect(res.cursor).toBeUndefined()
      })

      it('only returns posts matching the requested boundary', async () => {
        await store.upsertPost(
          makePost({
            uri: `at://${SPIKE_DID}/p/1`,
            boundaries: ['alpha'],
          }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${FAYE_DID}/p/2`,
            did: FAYE_DID,
            boundaries: ['beta'],
          }),
        )
        const alpha = await store.listPostsByBoundary({
          boundary: 'alpha',
          limit: 10,
        })
        expect(alpha.posts.map((p) => p.uri)).toEqual([`at://${SPIKE_DID}/p/1`])
      })

      it('paginates using cursor format <sortAt>::<uri>', async () => {
        for (let i = 1; i <= 5; i++) {
          await store.upsertPost(
            makePost({
              uri: `at://${SPIKE_DID}/p/${i}`,
              sortAt: `2024-01-0${i}T00:00:00.000Z`,
              boundaries: ['page'],
            }),
          )
        }
        const page1 = await store.listPostsByBoundary({
          boundary: 'page',
          limit: 2,
        })
        expect(page1.posts).toHaveLength(2)
        expect(page1.cursor).toBeDefined()
        expect(page1.cursor).toContain('::')
        const page2 = await store.listPostsByBoundary({
          boundary: 'page',
          limit: 2,
          cursor: page1.cursor,
        })
        expect(page2.posts).toHaveLength(2)
        const page3 = await store.listPostsByBoundary({
          boundary: 'page',
          limit: 2,
          cursor: page2.cursor,
        })
        expect(page3.posts).toHaveLength(1)
        expect(page3.cursor).toBeUndefined()
        const allUris = [...page1.posts, ...page2.posts, ...page3.posts].map(
          (p) => p.uri,
        )
        expect(new Set(allUris).size).toBe(5)
      })

      it('returns empty result for unknown boundary', async () => {
        await store.upsertPost(makePost())
        const res = await store.listPostsByBoundary({
          boundary: 'nonexistent',
          limit: 10,
        })
        expect(res.posts).toEqual([])
        expect(res.cursor).toBeUndefined()
      })
    })

    describe('sync cursor', () => {
      it('upserts and reads back', async () => {
        await store.upsertCursor(SPIKE_DID, 42, '2024-01-01T00:00:00.000Z')
        expect(await store.getCursor(SPIKE_DID)).toBe(42)
      })

      it('returns null for unknown did', async () => {
        expect(await store.getCursor('did:plc:unknown')).toBeNull()
      })

      it('overwrites on conflict', async () => {
        await store.upsertCursor(SPIKE_DID, 1, '2024-01-01T00:00:00.000Z')
        await store.upsertCursor(SPIKE_DID, 99, '2024-01-02T00:00:00.000Z')
        expect(await store.getCursor(SPIKE_DID)).toBe(99)
      })
    })

    describe('space sync cursor', () => {
      const SPACE_URI = `at://${SPIKE_DID}/space/feed/bounty-hunters`
      const OTHER_SPACE_URI = `at://${SPIKE_DID}/space/feed/syndicate`

      it('upserts and reads back', async () => {
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'cursor-1',
          '2024-01-01T00:00:00.000Z',
        )
        expect(await store.getSpaceCursor(SPACE_URI, FAYE_DID)).toBe('cursor-1')
      })

      it('returns null for unknown (space, member) pair', async () => {
        expect(
          await store.getSpaceCursor(SPACE_URI, 'did:plc:unknown'),
        ).toBeNull()
      })

      it('overwrites on conflict', async () => {
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'cursor-1',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'cursor-2',
          '2024-01-02T00:00:00.000Z',
        )
        expect(await store.getSpaceCursor(SPACE_URI, FAYE_DID)).toBe('cursor-2')
      })

      it('scopes cursors independently per (space, member) pair', async () => {
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'faye-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          SPACE_URI,
          VASH_DID,
          'vash-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          OTHER_SPACE_URI,
          FAYE_DID,
          'other-space-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        expect(await store.getSpaceCursor(SPACE_URI, FAYE_DID)).toBe(
          'faye-cursor',
        )
        expect(await store.getSpaceCursor(SPACE_URI, VASH_DID)).toBe(
          'vash-cursor',
        )
        expect(await store.getSpaceCursor(OTHER_SPACE_URI, FAYE_DID)).toBe(
          'other-space-cursor',
        )
      })

      it('deleteSpaceCursor removes one pair only and is idempotent', async () => {
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'faye-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          OTHER_SPACE_URI,
          FAYE_DID,
          'other-space-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        expect(await store.deleteSpaceCursor(SPACE_URI, FAYE_DID)).toBe(1)
        expect(await store.getSpaceCursor(SPACE_URI, FAYE_DID)).toBeNull()
        expect(await store.getSpaceCursor(OTHER_SPACE_URI, FAYE_DID)).toBe(
          'other-space-cursor',
        )
        // second call is a no-op
        expect(await store.deleteSpaceCursor(SPACE_URI, FAYE_DID)).toBe(0)
      })

      it('deleteSpaceCursors removes every cursor held for a did across spaces', async () => {
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'faye-cursor-1',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          OTHER_SPACE_URI,
          FAYE_DID,
          'faye-cursor-2',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          SPACE_URI,
          VASH_DID,
          'vash-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        expect(await store.deleteSpaceCursors(FAYE_DID)).toBe(2)
        expect(await store.getSpaceCursor(SPACE_URI, FAYE_DID)).toBeNull()
        expect(await store.getSpaceCursor(OTHER_SPACE_URI, FAYE_DID)).toBeNull()
        // VASH's cursor in the same space is untouched.
        expect(await store.getSpaceCursor(SPACE_URI, VASH_DID)).toBe(
          'vash-cursor',
        )
      })

      it('deleteSpaceCursorsBySpace removes every member cursor in one space', async () => {
        await store.upsertSpaceCursor(
          SPACE_URI,
          FAYE_DID,
          'faye-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          SPACE_URI,
          VASH_DID,
          'vash-cursor',
          '2024-01-01T00:00:00.000Z',
        )
        await store.upsertSpaceCursor(
          OTHER_SPACE_URI,
          FAYE_DID,
          'other-space-cursor',
          '2024-01-01T00:00:00.000Z',
        )

        expect(await store.deleteSpaceCursorsBySpace(SPACE_URI)).toBe(2)
        expect(await store.getSpaceCursor(SPACE_URI, FAYE_DID)).toBeNull()
        expect(await store.getSpaceCursor(SPACE_URI, VASH_DID)).toBeNull()
        expect(await store.getSpaceCursor(OTHER_SPACE_URI, FAYE_DID)).toBe(
          'other-space-cursor',
        )
        expect(await store.deleteSpaceCursorsBySpace(SPACE_URI)).toBe(0)
      })
    })

    describe('space member snapshot', () => {
      it('returns an empty snapshot for an unknown boundary', async () => {
        expect(await store.listSpaceMembers('unknown')).toEqual([])
      })

      it('atomically replaces one boundary without changing another', async () => {
        await store.replaceSpaceMembers('bounty-hunters', [
          { did: VASH_DID, custody: 'stratos' },
          { did: FAYE_DID, custody: 'stratos' },
          {
            did: FAYE_DID,
            custody: 'pds',
            host: 'https://pds.faye.example',
          },
        ])
        await store.replaceSpaceMembers('nerv', [
          { did: SHINJI_DID, custody: 'pds' },
        ])

        expect(await store.listSpaceMembers('bounty-hunters')).toEqual([
          {
            did: FAYE_DID,
            custody: 'pds',
            host: 'https://pds.faye.example',
          },
          { did: VASH_DID, custody: 'stratos' },
        ])

        await store.replaceSpaceMembers('bounty-hunters', [
          { did: SPIKE_DID, custody: 'pds', host: 'https://pds.spike.example' },
        ])
        expect(await store.listSpaceMembers('bounty-hunters')).toEqual([
          {
            did: SPIKE_DID,
            custody: 'pds',
            host: 'https://pds.spike.example',
          },
        ])
        expect(await store.listSpaceMembers('nerv')).toEqual([
          { did: SHINJI_DID, custody: 'pds' },
        ])
      })

      it('replaces a boundary with an empty snapshot', async () => {
        await store.replaceSpaceMembers('bounty-hunters', [
          { did: SPIKE_DID, custody: 'pds' },
        ])
        await store.replaceSpaceMembers('bounty-hunters', [])
        expect(await store.listSpaceMembers('bounty-hunters')).toEqual([])
      })
    })

    describe('enrolled actor', () => {
      it('upserts and reads back', async () => {
        const a = makeActor()
        await store.upsertEnrolledActor(a)
        const fetched = await store.getEnrolledActor(a.did)
        expect(fetched).toEqual(a)
      })

      it('returns null for unknown did', async () => {
        expect(await store.getEnrolledActor('did:plc:unknown')).toBeNull()
      })

      it('updates boundaries on conflict', async () => {
        await store.upsertEnrolledActor(
          makeActor({ boundaries: ['old-a', 'old-b'] }),
        )
        await store.upsertEnrolledActor(
          makeActor({
            boundaries: ['new'],
            lastSeenAt: '2024-06-01T00:00:00.000Z',
          }),
        )
        const fetched = await store.getEnrolledActor(SPIKE_DID)
        expect(fetched!.boundaries).toEqual(['new'])
        expect(fetched!.lastSeenAt).toBe('2024-06-01T00:00:00.000Z')
      })

      it('lists all enrolled actors', async () => {
        await store.upsertEnrolledActor(makeActor({ did: SPIKE_DID }))
        await store.upsertEnrolledActor(makeActor({ did: FAYE_DID }))
        await store.upsertEnrolledActor(makeActor({ did: SHINJI_DID }))
        const all = await store.listEnrolledActors()
        expect(all.map((a) => a.did).sort()).toEqual(
          [SPIKE_DID, FAYE_DID, SHINJI_DID].sort(),
        )
      })

      it('deletes an enrolled actor', async () => {
        await store.upsertEnrolledActor(makeActor())
        await store.deleteEnrolledActor(SPIKE_DID)
        expect(await store.getEnrolledActor(SPIKE_DID)).toBeNull()
      })
    })

    describe('purge helpers', () => {
      it('deletePostsByDid removes all of a DID posts and cascades index rows', async () => {
        await store.upsertPost(
          makePost({ uri: `at://${SPIKE_DID}/p/1`, boundaries: ['a', 'b'] }),
        )
        await store.upsertPost(
          makePost({ uri: `at://${SPIKE_DID}/p/2`, boundaries: ['a'] }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${FAYE_DID}/p/1`,
            did: FAYE_DID,
            boundaries: ['a'],
          }),
        )
        const removed = await store.deletePostsByDid(SPIKE_DID)
        expect(removed).toBe(2)
        expect(await store.getPost(`at://${SPIKE_DID}/p/1`)).toBeNull()
        expect(await store.getPost(`at://${SPIKE_DID}/p/2`)).toBeNull()
        // FAYE's post survives.
        expect(await store.getPost(`at://${FAYE_DID}/p/1`)).not.toBeNull()
        // Index rows cascaded: boundary 'a' now only holds FAYE's post.
        const inA = await store.listPostsByBoundary({
          boundary: 'a',
          limit: 10,
        })
        expect(inA.posts.map((p) => p.uri)).toEqual([`at://${FAYE_DID}/p/1`])
        const inB = await store.listPostsByBoundary({
          boundary: 'b',
          limit: 10,
        })
        expect(inB.posts).toEqual([])
      })

      it('deletePostsByDid returns 0 for a DID with no posts (idempotent)', async () => {
        expect(await store.deletePostsByDid(VASH_DID)).toBe(0)
      })

      it('deletePostsByDidBoundary drops the boundary and deletes now-orphaned posts', async () => {
        // p1 is only in the lost boundary -> deleted; p2 also has another
        // boundary -> survives but loses the membership; FAYE's post untouched.
        await store.upsertPost(
          makePost({ uri: `at://${SPIKE_DID}/p/1`, boundaries: ['gone'] }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${SPIKE_DID}/p/2`,
            boundaries: ['gone', 'kept'],
          }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${FAYE_DID}/p/1`,
            did: FAYE_DID,
            boundaries: ['gone'],
          }),
        )
        const fullyDeleted = await store.deletePostsByDidBoundary(
          SPIKE_DID,
          'gone',
        )
        expect(fullyDeleted).toBe(1)
        expect(await store.getPost(`at://${SPIKE_DID}/p/1`)).toBeNull()
        const p2 = await store.getPost(`at://${SPIKE_DID}/p/2`)
        expect(p2).not.toBeNull()
        expect(p2!.boundaries).toEqual(['kept'])
        // FAYE's membership in 'gone' is untouched.
        const inGone = await store.listPostsByBoundary({
          boundary: 'gone',
          limit: 10,
        })
        expect(inGone.posts.map((p) => p.uri)).toEqual([`at://${FAYE_DID}/p/1`])
      })

      it('deletePostsByDidBoundary leaves pre-existing boundaryless posts alone', async () => {
        // p1 never referenced the dropped boundary and has no boundaries at
        // all - it must not be swept up by the orphan check.
        await store.upsertPost(
          makePost({ uri: `at://${SPIKE_DID}/p/1`, boundaries: [] }),
        )
        await store.upsertPost(
          makePost({ uri: `at://${SPIKE_DID}/p/2`, boundaries: ['gone'] }),
        )
        const deleted = await store.deletePostsByDidBoundary(SPIKE_DID, 'gone')
        expect(deleted).toBe(1)
        expect(await store.getPost(`at://${SPIKE_DID}/p/2`)).toBeNull()
        // The boundaryless post survives.
        expect(await store.getPost(`at://${SPIKE_DID}/p/1`)).not.toBeNull()
      })

      it('deletePostsByDidBoundary returns 0 when the DID holds no posts in the boundary', async () => {
        await store.upsertPost(
          makePost({ uri: `at://${SPIKE_DID}/p/1`, boundaries: [] }),
        )
        expect(await store.deletePostsByDidBoundary(SPIKE_DID, 'gone')).toBe(0)
        expect(await store.getPost(`at://${SPIKE_DID}/p/1`)).not.toBeNull()
      })

      it('guarded actor-boundary deletion commits or rolls back cursor and posts together', async () => {
        const spaceUri = `at://${SPIKE_DID}/zone.stratos.space.feed/gone`
        const post = makePost({
          uri: `at://${SPIKE_DID}/p/guarded`,
          boundaries: ['gone'],
        })
        await store.upsertPost(post)
        await store.upsertSpaceCursor(
          spaceUri,
          SPIKE_DID,
          'cursor-1',
          '2024-01-01T00:00:00.000Z',
        )

        expect(
          await store.deleteActorBoundaryStateGuarded(
            spaceUri,
            SPIKE_DID,
            'gone',
            () => false,
          ),
        ).toEqual({ committed: false, posts: 0, spaceCursors: 0 })
        expect(await store.getPost(post.uri)).not.toBeNull()
        expect(await store.getSpaceCursor(spaceUri, SPIKE_DID)).toBe('cursor-1')

        expect(
          await store.deleteActorBoundaryStateGuarded(
            spaceUri,
            SPIKE_DID,
            'gone',
            () => true,
          ),
        ).toEqual({ committed: true, posts: 1, spaceCursors: 1 })
        expect(await store.getPost(post.uri)).toBeNull()
        expect(await store.getSpaceCursor(spaceUri, SPIKE_DID)).toBeNull()
      })

      it('deletePostsByDidBoundary remains set-based beyond legacy SQLite bind limits', async () => {
        const postCount = 1_100
        for (let index = 0; index < postCount; index += 1) {
          await store.upsertPost(
            makePost({
              uri: `at://${SPIKE_DID}/p/scale-${index}`,
              boundaries: ['gone'],
            }),
          )
        }

        expect(await store.deletePostsByDidBoundary(SPIKE_DID, 'gone')).toBe(
          postCount,
        )
        expect(
          await store.listPostsByBoundary({ boundary: 'gone', limit: 1 }),
        ).toEqual({ posts: [] })
      })

      it('deletePostsByBoundary removes every actor post in a boundary service-wide', async () => {
        await store.upsertPost(
          makePost({
            uri: `at://${SPIKE_DID}/p/1`,
            boundaries: ['space', 'other'],
          }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${FAYE_DID}/p/1`,
            did: FAYE_DID,
            boundaries: ['space'],
          }),
        )
        await store.upsertPost(
          makePost({
            uri: `at://${VASH_DID}/p/1`,
            did: VASH_DID,
            boundaries: ['unrelated'],
          }),
        )
        const removed = await store.deletePostsByBoundary('space')
        expect(removed).toBe(2)
        expect(await store.getPost(`at://${SPIKE_DID}/p/1`)).toBeNull()
        expect(await store.getPost(`at://${FAYE_DID}/p/1`)).toBeNull()
        // A post that merely shared another boundary with a deleted post is
        // still deleted (it was scoped to 'space'); the unrelated one survives.
        expect(await store.getPost(`at://${VASH_DID}/p/1`)).not.toBeNull()
        const other = await store.listPostsByBoundary({
          boundary: 'other',
          limit: 10,
        })
        expect(other.posts).toEqual([])
      })

      it('deleteCursor removes cursor state and is idempotent', async () => {
        await store.upsertCursor(SPIKE_DID, 7, '2024-01-01T00:00:00.000Z')
        expect(await store.deleteCursor(SPIKE_DID)).toBe(1)
        expect(await store.getCursor(SPIKE_DID)).toBeNull()
        // second call is a no-op
        expect(await store.deleteCursor(SPIKE_DID)).toBe(0)
      })
    })
  })
}
