import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSqliteDb,
  type FeedgenStore,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import { SubscriptionIndexer } from '../src/subscription/index.js'

let store: FeedgenStore
let indexer: SubscriptionIndexer
const tmpDirs: string[] = []

async function makeStore(): Promise<FeedgenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-indexer-'))
  tmpDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  return new SqliteFeedgenStore(db)
}

beforeEach(async () => {
  store = await makeStore()
  indexer = new SubscriptionIndexer(store)
})

afterEach(async () => {
  await store.close()
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

const DID = 'did:plc:alice'
const RKEY = '3kjabc'
const POST_PATH = `zone.stratos.feed.post/${RKEY}`
const URI = `at://${DID}/${POST_PATH}`

function postRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $type: 'zone.stratos.feed.post',
    text: 'hello',
    createdAt: '2024-01-01T00:00:00.000Z',
    boundary: { values: [{ value: 'example.com/eng' }] },
    ...overrides,
  }
}

describe('SubscriptionIndexer', () => {
  it('upserts a post and advances the cursor', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 5,
      time: '2024-01-02T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: POST_PATH,
          cid: 'bafy1',
          record: postRecord(),
        },
      ],
    })
    const got = await store.getPost(URI)
    expect(got).toBeTruthy()
    expect(got?.boundaries).toEqual(['example.com/eng'])
    expect(got?.sortAt).toBe('2024-01-01T00:00:00.000Z')
    expect(await store.getCursor(DID)).toBe(5)
  })

  it('falls back to commit time when createdAt is missing', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-03-03T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: POST_PATH,
          cid: 'bafy1',
          record: postRecord({ createdAt: undefined }),
        },
      ],
    })
    const got = await store.getPost(URI)
    expect(got?.sortAt).toBe('2024-03-03T00:00:00.000Z')
  })

  it('deletes a post on a delete op', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: POST_PATH,
          cid: 'bafy1',
          record: postRecord(),
        },
      ],
    })
    await indexer.applyCommit({
      did: DID,
      seq: 2,
      time: '2024-01-03T00:00:00.000Z',
      ops: [{ action: 'delete', path: POST_PATH }],
    })
    expect(await store.getPost(URI)).toBeNull()
    expect(await store.getCursor(DID)).toBe(2)
  })

  // verify the normal record-delete op also purges the derived index
  // (post_boundary) rows, not just the post row. This is the "Record deleted
  // (normal op)" trigger from the deletion contract.
  it('delete op cascades to boundary index rows', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: POST_PATH,
          cid: 'bafy1',
          record: postRecord(),
        },
      ],
    })
    // Present in the feed before delete.
    const before = await store.listPostsByBoundary({
      boundary: 'example.com/eng',
      limit: 10,
    })
    expect(before.posts.map((p) => p.uri)).toEqual([URI])

    await indexer.applyCommit({
      did: DID,
      seq: 2,
      time: '2024-01-03T00:00:00.000Z',
      ops: [{ action: 'delete', path: POST_PATH }],
    })
    // Gone from the feed/index after delete (cascade).
    const after = await store.listPostsByBoundary({
      boundary: 'example.com/eng',
      limit: 10,
    })
    expect(after.posts).toEqual([])
  })

  it('ignores non-zone.stratos.feed.post collections', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: 'app.bsky.feed.post/abc',
          cid: 'bafyX',
          record: { $type: 'app.bsky.feed.post', text: 'nope' },
        },
      ],
    })
    expect(await store.getPost(`at://${DID}/app.bsky.feed.post/abc`)).toBeNull()
    expect(await store.getCursor(DID)).toBe(1)
  })

  it('ignores ops whose record $type does not match the path collection', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: POST_PATH,
          cid: 'bafy1',
          record: { $type: 'something.else', text: 'no' },
        },
      ],
    })
    expect(await store.getPost(URI)).toBeNull()
  })

  it('extracts blob refs from embed.images shape', async () => {
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: POST_PATH,
          cid: 'bafy1',
          record: postRecord({
            embed: {
              $type: 'app.bsky.embed.images',
              images: [
                {
                  alt: 'pic',
                  image: {
                    $type: 'blob',
                    ref: { $link: 'bafyimg1' },
                    mimeType: 'image/png',
                    size: 1234,
                  },
                },
              ],
            },
          }),
        },
      ],
    })
    const got = await store.getPost(URI)
    expect(got?.blobRefs).toEqual([{ cid: 'bafyimg1', mimeType: 'image/png' }])
  })

  it('is idempotent: replaying the same commit yields the same row', async () => {
    const ops = [
      {
        action: 'create' as const,
        path: POST_PATH,
        cid: 'bafy1',
        record: postRecord(),
      },
    ]
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops,
    })
    await indexer.applyCommit({
      did: DID,
      seq: 1,
      time: '2024-01-02T00:00:00.000Z',
      ops,
    })
    const got = await store.getPost(URI)
    expect(got).toBeTruthy()
    expect(await store.getCursor(DID)).toBe(1)
  })
})
