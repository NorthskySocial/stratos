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
import { Purger, type PurgeAudit } from '../src/purge/index.js'

// ---- Fixtures ----------------------------------------------------------

const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'

let store: FeedgenStore
const tmpDirs: string[] = []

async function makeStore(): Promise<FeedgenStore> {
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-purge-'))
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
    blobRefs: [{ cid: `blob-${rkey}` }],
    boundaries,
  }
}

function makeCache() {
  const invalidated: string[] = []
  return {
    invalidated,
    invalidate: vi.fn((did: string) => {
      invalidated.push(did)
    }),
  }
}

function makePool() {
  const removed: string[] = []
  return {
    removed,
    removeActor: vi.fn((did: string) => {
      removed.push(did)
    }),
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

// ---- Unenroll ----------------------------------------------------------

describe('Purger.purgeActor (unenroll)', () => {
  async function seed() {
    // Out of scope: everything for SPIKE.
    await store.upsertPost(post(SPIKE, '1', ['crew', 'bounty']))
    await store.upsertPost(post(SPIKE, '2', ['crew']))
    await store.upsertCursor(SPIKE, 10, '2024-01-01T00:00:00.000Z')
    await store.upsertEnrolledActor({
      did: SPIKE,
      boundaries: ['crew', 'bounty'],
      enrolledAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    })
    // In scope: FAYE stays fully intact.
    await store.upsertPost(post(FAYE, '1', ['crew']))
    await store.upsertCursor(FAYE, 5, '2024-01-01T00:00:00.000Z')
    await store.upsertEnrolledActor({
      did: FAYE,
      boundaries: ['crew'],
      enrolledAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    })
  }

  it('purges every store the feedgen holds for the actor; leaves others intact', async () => {
    await seed()
    const cache = makeCache()
    const pool = makePool()
    const audits: PurgeAudit[] = []
    const purger = new Purger({
      store,
      enrollmentCache: cache,
      actorPool: pool,
      audit: (e) => audits.push(e),
    })

    const counts = await purger.purgeActor(SPIKE)

    // posts + cascaded index rows gone
    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/2`),
    ).toBeNull()
    expect(
      (await store.listPostsByBoundary({ boundary: 'bounty', limit: 10 }))
        .posts,
    ).toEqual([])
    // cursor gone
    expect(await store.getCursor(SPIKE)).toBeNull()
    // enrolled snapshot gone
    expect(await store.getEnrolledActor(SPIKE)).toBeNull()
    // live syncer torn down + cache invalidated
    expect(pool.removed).toEqual([SPIKE])
    expect(cache.invalidated).toEqual([SPIKE])

    // FAYE fully intact
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
    expect(await store.getCursor(FAYE)).toBe(5)
    expect(await store.getEnrolledActor(FAYE)).not.toBeNull()

    expect(counts).toEqual({
      posts: 2,
      cursors: 1,
      spaceCursors: 0,
      enrolledActors: 1,
      boundaryCache: 1,
    })
    expect(audits).toEqual([{ trigger: 'unenroll', did: SPIKE, counts }])
  })

  it('is idempotent: a second unenroll removes nothing and does not throw', async () => {
    await seed()
    const purger = new Purger({ store, audit: () => {} })
    const first = await purger.purgeActor(SPIKE)
    expect(first.posts).toBe(2)
    const second = await purger.purgeActor(SPIKE)
    expect(second).toEqual({
      posts: 0,
      cursors: 0,
      spaceCursors: 0,
      enrolledActors: 0,
      boundaryCache: 0,
    })
    // FAYE still intact after the double purge.
    expect(await store.getEnrolledActor(FAYE)).not.toBeNull()
  })

  it('works without an actor pool or cache (optional deps)', async () => {
    await seed()
    const purger = new Purger({ store, audit: () => {} })
    const counts = await purger.purgeActor(SPIKE)
    expect(counts.posts).toBe(2)
    expect(counts.boundaryCache).toBe(0)
  })

  it('removes space-sync cursors held by the actor, leaving other members untouched', async () => {
    await seed()
    const spaceUri =
      'at://did:web:stratos.test/space/zone.stratos.space.feed/crew'
    await store.upsertSpaceCursor(
      spaceUri,
      SPIKE,
      'rev-1',
      '2024-01-01T00:00:00.000Z',
    )
    await store.upsertSpaceCursor(
      spaceUri,
      FAYE,
      'rev-2',
      '2024-01-01T00:00:00.000Z',
    )
    const audits: PurgeAudit[] = []
    const purger = new Purger({ store, audit: (e) => audits.push(e) })

    const counts = await purger.purgeActor(SPIKE)

    expect(await store.getSpaceCursor(spaceUri, SPIKE)).toBeNull()
    expect(await store.getSpaceCursor(spaceUri, FAYE)).toBe('rev-2')
    expect(counts.spaceCursors).toBe(1)
    expect(audits[0]!.counts.spaceCursors).toBe(1)
  })
})

// ---- Boundary shrink ---------------------------------------------------

describe('Purger.purgeActorBoundary (boundary shrink)', () => {
  it('purges posts left with no boundary; keeps multi-boundary posts and the actor snapshot', async () => {
    // SPIKE leaves 'bounty'. p1 (bounty only) -> deleted; p2 (bounty+crew) ->
    // survives, loses 'bounty'; FAYE untouched.
    await store.upsertPost(post(SPIKE, '1', ['bounty']))
    await store.upsertPost(post(SPIKE, '2', ['bounty', 'crew']))
    await store.upsertEnrolledActor({
      did: SPIKE,
      boundaries: ['bounty', 'crew'],
      enrolledAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    })
    await store.upsertPost(post(FAYE, '1', ['bounty']))

    const cache = makeCache()
    const audits: PurgeAudit[] = []
    const purger = new Purger({
      store,
      enrollmentCache: cache,
      audit: (e) => audits.push(e),
    })

    const counts = await purger.purgeActorBoundary(SPIKE, 'bounty')

    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    const p2 = await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/2`)
    expect(p2!.boundaries).toEqual(['crew'])
    // Actor is still enrolled -> snapshot untouched by this call.
    expect(await store.getEnrolledActor(SPIKE)).not.toBeNull()
    // FAYE's membership in 'bounty' untouched.
    expect(
      (
        await store.listPostsByBoundary({ boundary: 'bounty', limit: 10 })
      ).posts.map((p) => p.uri),
    ).toEqual([`at://${FAYE}/zone.stratos.feed.post/1`])
    expect(cache.invalidated).toEqual([SPIKE])
    expect(counts.posts).toBe(1)
    expect(audits[0]).toEqual({
      trigger: 'boundary-shrink',
      did: SPIKE,
      boundary: 'bounty',
      counts,
    })
  })

  it('is idempotent', async () => {
    await store.upsertPost(post(SPIKE, '1', ['bounty']))
    const purger = new Purger({ store, audit: () => {} })
    expect((await purger.purgeActorBoundary(SPIKE, 'bounty')).posts).toBe(1)
    expect((await purger.purgeActorBoundary(SPIKE, 'bounty')).posts).toBe(0)
  })

  it('drops the space-sync cursor when the trigger is space-commit-invalid with a spaceUri', async () => {
    const spaceUri = 'at://did:web:stratos.test/space/zone.stratos.space.feed/crew'
    await store.upsertSpaceCursor(
      spaceUri,
      SPIKE,
      'rev-1',
      '2024-01-01T00:00:00.000Z',
    )
    const purger = new Purger({ store, audit: () => {} })

    const counts = await purger.purgeActorBoundary(
      SPIKE,
      'crew',
      'space-commit-invalid',
      spaceUri,
    )

    expect(await store.getSpaceCursor(spaceUri, SPIKE)).toBeNull()
    expect(counts.spaceCursors).toBe(1)
  })

  it('leaves the space-sync cursor alone without a spaceUri, even for space-commit-invalid', async () => {
    const spaceUri = 'at://did:web:stratos.test/space/zone.stratos.space.feed/crew'
    await store.upsertSpaceCursor(
      spaceUri,
      SPIKE,
      'rev-1',
      '2024-01-01T00:00:00.000Z',
    )
    const purger = new Purger({ store, audit: () => {} })

    const counts = await purger.purgeActorBoundary(
      SPIKE,
      'crew',
      'space-commit-invalid',
    )

    expect(await store.getSpaceCursor(spaceUri, SPIKE)).toBe('rev-1')
    expect(counts.spaceCursors).toBe(0)
  })

  it('leaves the space-sync cursor alone for a boundary-shrink trigger even with a spaceUri', async () => {
    const spaceUri = 'at://did:web:stratos.test/space/zone.stratos.space.feed/crew'
    await store.upsertSpaceCursor(
      spaceUri,
      SPIKE,
      'rev-1',
      '2024-01-01T00:00:00.000Z',
    )
    const purger = new Purger({ store, audit: () => {} })

    const counts = await purger.purgeActorBoundary(
      SPIKE,
      'crew',
      'boundary-shrink',
      spaceUri,
    )

    expect(await store.getSpaceCursor(spaceUri, SPIKE)).toBe('rev-1')
    expect(counts.spaceCursors).toBe(0)
  })
})

// ---- Boundary deletion (service-wide) ----------------------------------

describe('Purger.purgeBoundary (space deleted service-wide)', () => {
  it('purges every actor post scoped to the boundary; leaves cursors/snapshots', async () => {
    await store.upsertPost(post(SPIKE, '1', ['space']))
    await store.upsertPost(post(FAYE, '1', ['space', 'other']))
    await store.upsertPost(post(FAYE, '2', ['other']))
    await store.upsertCursor(SPIKE, 3, '2024-01-01T00:00:00.000Z')
    await store.upsertEnrolledActor({
      did: FAYE,
      boundaries: ['other'],
      enrolledAt: '2024-01-01T00:00:00.000Z',
      lastSeenAt: '2024-01-01T00:00:00.000Z',
    })

    const audits: PurgeAudit[] = []
    const purger = new Purger({ store, audit: (e) => audits.push(e) })

    const counts = await purger.purgeBoundary('space')

    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    // A post only in 'other' survives.
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/2`),
    ).not.toBeNull()
    // Cursor and enrolled snapshot are per-actor, left intact.
    expect(await store.getCursor(SPIKE)).toBe(3)
    expect(await store.getEnrolledActor(FAYE)).not.toBeNull()
    expect(counts.posts).toBe(2)
    expect(audits[0]).toEqual({
      trigger: 'boundary-deleted',
      boundary: 'space',
      counts,
    })
  })

  it('is idempotent', async () => {
    await store.upsertPost(post(SPIKE, '1', ['space']))
    const purger = new Purger({ store, audit: () => {} })
    expect((await purger.purgeBoundary('space')).posts).toBe(1)
    expect((await purger.purgeBoundary('space')).posts).toBe(0)
  })
})
