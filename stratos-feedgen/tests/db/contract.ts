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
  })
}
