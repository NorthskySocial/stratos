import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteDb,
  type FeedgenStore,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import { Purger, reconcileEnrollments } from '../src/purge/index.js'
import type { ResolveEnrollmentsResult } from '../src/upstream/index.js'

const SPIKE = 'did:plc:spikespiegel' // will be reported unenrolled
const FAYE = 'did:plc:fayevalentine' // boundary shrink
const VASH = 'did:plc:vashstampede' // unchanged, still in scope

let store: FeedgenStore
const tmpDirs: string[] = []

async function makeStore(): Promise<FeedgenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-reconcile-'))
  tmpDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  return new SqliteFeedgenStore(db)
}

function post(did: string, rkey: string, boundaries: string[]) {
  return {
    uri: `at://${did}/zone.stratos.feed.post/${rkey}`,
    did,
    cid: `cid-${rkey}`,
    sortAt: '2024-01-01T00:00:00.000Z',
    indexedAt: '2024-01-01T00:00:00.000Z',
    record: { text: rkey },
    blobRefs: [],
    boundaries,
  }
}

function actor(did: string, boundaries: string[]) {
  return {
    did,
    boundaries,
    enrolledAt: '2024-01-01T00:00:00.000Z',
    lastSeenAt: '2024-01-01T00:00:00.000Z',
  }
}

beforeEach(async () => {
  store = await makeStore()
})

afterEach(async () => {
  await store.close()
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

describe('reconcileEnrollments', () => {
  it('purges actors that unenrolled and boundaries that shrank while down; leaves in-scope intact', async () => {
    // Stale persisted snapshot (what we cached before going down).
    await store.upsertEnrolledActor(actor(SPIKE, ['crew']))
    await store.upsertEnrolledActor(actor(FAYE, ['crew', 'bounty']))
    await store.upsertEnrolledActor(actor(VASH, ['crew']))

    await store.upsertPost(post(SPIKE, '1', ['crew']))
    await store.upsertCursor(SPIKE, 1, '2024-01-01T00:00:00.000Z')
    await store.upsertPost(post(FAYE, '1', ['bounty'])) // out of scope after shrink
    await store.upsertPost(post(FAYE, '2', ['crew'])) // stays
    await store.upsertPost(post(VASH, '1', ['crew'])) // stays

    const configured = new Set(['crew', 'bounty'])

    // Fresh snapshot: SPIKE gone, FAYE lost 'bounty', VASH unchanged.
    const fresh: Record<string, ResolveEnrollmentsResult> = {
      [SPIKE]: { did: SPIKE, enrolled: false, boundaries: [] },
      [FAYE]: { did: FAYE, enrolled: true, boundaries: ['crew'] },
      [VASH]: { did: VASH, enrolled: true, boundaries: ['crew'] },
    }
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => fresh[did]),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summaries: unknown[] = []

    const summary = await reconcileEnrollments(
      { store, purger, client, log: (s) => summaries.push(s) },
      configured,
    )

    // SPIKE fully purged.
    expect(await store.getEnrolledActor(SPIKE)).toBeNull()
    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect(await store.getCursor(SPIKE)).toBeNull()
    // FAYE's out-of-scope post purged, in-scope kept, snapshot refreshed.
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/2`),
    ).not.toBeNull()
    expect((await store.getEnrolledActor(FAYE))!.boundaries).toEqual(['crew'])
    // VASH untouched.
    expect(
      await store.getPost(`at://${VASH}/zone.stratos.feed.post/1`),
    ).not.toBeNull()

    expect(summary.examined).toBe(3)
    expect(summary.unenrolled).toBe(1)
    expect(summary.shrunk).toBe(1)
    expect(summary.postsPurged).toBe(2)
    expect(summary.errors).toBe(0)
    expect(summaries).toHaveLength(1)
  })

  it('bounds work: maxActors caps the number examined', async () => {
    for (let i = 0; i < 10; i++) {
      await store.upsertEnrolledActor(actor(`did:plc:actor${i}`, ['crew']))
    }
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: ['crew'],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set(['crew']),
      { maxActors: 4, batchSize: 2 },
    )
    expect(summary.examined).toBe(4)
    expect(client.resolveEnrollments).toHaveBeenCalledTimes(4)
  })

  it('skips (does not abort) an actor whose resolve fails', async () => {
    await store.upsertEnrolledActor(actor(SPIKE, ['crew']))
    await store.upsertEnrolledActor(actor(FAYE, ['crew']))
    await store.upsertPost(post(FAYE, '1', ['crew']))
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => {
        if (did === SPIKE) throw new Error('upstream down')
        return { did, enrolled: true, boundaries: ['crew'] }
      }),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {}, onError: () => {} },
      new Set(['crew']),
    )
    expect(summary.errors).toBe(1)
    expect(summary.examined).toBe(2)
    // FAYE (in scope) untouched; SPIKE left for the next run, not purged.
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
    expect(await store.getEnrolledActor(SPIKE)).not.toBeNull()
  })

  it('is a no-op when the cache already matches the fresh snapshot', async () => {
    await store.upsertEnrolledActor(actor(VASH, ['crew']))
    await store.upsertPost(post(VASH, '1', ['crew']))
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: ['crew'],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set(['crew']),
    )
    expect(summary.unenrolled).toBe(0)
    expect(summary.shrunk).toBe(0)
    expect(summary.postsPurged).toBe(0)
    expect(
      await store.getPost(`at://${VASH}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
  })

  it('falls back to the default batch size for non-positive batchSize', async () => {
    // batchSize: 0 would never advance the batching loop (infinite loop);
    // it must be treated as unset, and the run must still complete.
    await store.upsertEnrolledActor(actor(VASH, ['crew']))
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: ['crew'],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    for (const batchSize of [0, -5]) {
      const summary = await reconcileEnrollments(
        { store, purger, client, log: () => {} },
        new Set(['crew']),
        { batchSize },
      )
      expect(summary.examined).toBe(1)
    }
  })

  it('persists boundary expansions so a later shrink is purged', async () => {
    // Run 1: fresh state EXPANDS from ['crew'] to ['crew', 'bounty'] - no
    // loss detected, but the snapshot must still be persisted, otherwise the
    // next run diffs against the stale set and never notices losing 'bounty'.
    await store.upsertEnrolledActor(actor(FAYE, ['crew']))
    const expandClient = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: ['crew', 'bounty'],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    await reconcileEnrollments(
      { store, purger, client: expandClient, log: () => {} },
      new Set(['crew', 'bounty']),
    )
    expect((await store.getEnrolledActor(FAYE))?.boundaries.sort()).toEqual(
      ['bounty', 'crew'].sort(),
    )

    // Posts indexed under the expanded boundary while it was held.
    await store.upsertPost(post(FAYE, '1', ['bounty']))

    // Run 2: 'bounty' is revoked. Because the expansion was persisted, the
    // diff sees the loss and purges the boundary's posts.
    const shrinkClient = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: ['crew'],
      })),
    }
    const summary = await reconcileEnrollments(
      { store, purger, client: shrinkClient, log: () => {} },
      new Set(['crew', 'bounty']),
    )
    expect(summary.shrunk).toBe(1)
    expect(summary.postsPurged).toBe(1)
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect((await store.getEnrolledActor(FAYE))?.boundaries).toEqual(['crew'])
  })
})
