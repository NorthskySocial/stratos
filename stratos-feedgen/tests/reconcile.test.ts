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
import {
  createReconcileScheduler,
  Purger,
  reconcileEnrollments,
  type PurgeAudit,
} from '../src/purge/index.js'
import { SpaceMutationFence } from '../src/space-sync/index.js'
import type { ResolveEnrollmentsResult } from '../src/upstream/index.js'

const SPIKE = 'did:plc:spikespiegel' // will be reported unenrolled
const FAYE = 'did:plc:fayevalentine' // boundary shrink
const VASH = 'did:plc:vashstampede' // unchanged, still in scope
const STRATOS_DID = 'did:web:stratos.test'
const CREW_BOUNDARY = `${STRATOS_DID}/crew`
const BOUNTY_BOUNDARY = `${STRATOS_DID}/bounty`
const BOUNTY_SPACE =
  'at://did:web:stratos.test/space/zone.stratos.space.feed/bounty'

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
    await store.upsertEnrolledActor(actor(SPIKE, [CREW_BOUNDARY]))
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await store.upsertEnrolledActor(actor(VASH, [CREW_BOUNDARY]))

    await store.upsertPost(post(SPIKE, '1', [CREW_BOUNDARY]))
    await store.upsertCursor(SPIKE, 1, '2024-01-01T00:00:00.000Z')
    await store.upsertPost(post(FAYE, '1', [BOUNTY_BOUNDARY])) // out of scope after shrink
    await store.upsertPost(post(FAYE, '2', [CREW_BOUNDARY])) // stays
    await store.upsertCursor(FAYE, 9, '2024-01-01T00:00:00.000Z')
    await store.upsertSpaceCursor(
      BOUNTY_SPACE,
      FAYE,
      'rev-9',
      '2024-01-01T00:00:00.000Z',
    )
    await store.upsertPost(post(VASH, '1', [CREW_BOUNDARY])) // stays

    const configured = new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY])

    // Fresh snapshot: SPIKE gone, FAYE lost 'bounty', VASH unchanged.
    const fresh: Record<string, ResolveEnrollmentsResult> = {
      [SPIKE]: { did: SPIKE, enrolled: false, boundaries: [] },
      [FAYE]: { did: FAYE, enrolled: true, boundaries: [CREW_BOUNDARY] },
      [VASH]: { did: VASH, enrolled: true, boundaries: [CREW_BOUNDARY] },
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
    expect((await store.getEnrolledActor(FAYE))!.boundaries).toEqual([
      CREW_BOUNDARY,
    ])
    expect(await store.getCursor(FAYE)).toBe(9)
    expect(await store.getSpaceCursor(BOUNTY_SPACE, FAYE)).toBeNull()
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
      await store.upsertEnrolledActor(
        actor(`did:plc:actor${i}`, [CREW_BOUNDARY]),
      )
    }
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: [CREW_BOUNDARY],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set([CREW_BOUNDARY]),
      { maxActors: 4, batchSize: 2 },
    )
    expect(summary.examined).toBe(4)
    expect(client.resolveEnrollments).toHaveBeenCalledTimes(4)
  })

  it('skips (does not abort) an actor whose resolve fails', async () => {
    await store.upsertEnrolledActor(actor(SPIKE, [CREW_BOUNDARY]))
    await store.upsertEnrolledActor(actor(FAYE, [CREW_BOUNDARY]))
    await store.upsertPost(post(FAYE, '1', [CREW_BOUNDARY]))
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => {
        if (did === SPIKE) throw new Error('upstream down')
        return { did, enrolled: true, boundaries: [CREW_BOUNDARY] }
      }),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {}, onError: () => {} },
      new Set([CREW_BOUNDARY]),
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
    await store.upsertEnrolledActor(actor(VASH, [CREW_BOUNDARY]))
    await store.upsertPost(post(VASH, '1', [CREW_BOUNDARY]))
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: [CREW_BOUNDARY],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set([CREW_BOUNDARY]),
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
    await store.upsertEnrolledActor(actor(VASH, [CREW_BOUNDARY]))
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: [CREW_BOUNDARY],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    for (const batchSize of [0, -5]) {
      const summary = await reconcileEnrollments(
        { store, purger, client, log: () => {} },
        new Set([CREW_BOUNDARY]),
        { batchSize },
      )
      expect(summary.examined).toBe(1)
    }
  })

  it('persists boundary expansions so a later shrink is purged', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00.000Z') })
    try {
      // Run 1: fresh state expands from crew to crew+bounty. No loss is
      // detected, but the snapshot must still be persisted, otherwise the next
      // run diffs against the stale set and never notices losing bounty.
      await store.upsertEnrolledActor(actor(FAYE, [CREW_BOUNDARY]))
      const expandClient = {
        resolveEnrollments: vi.fn(async (did: string) => ({
          did,
          enrolled: true,
          boundaries: [CREW_BOUNDARY, BOUNTY_BOUNDARY],
        })),
      }
      const purger = new Purger({ store, audit: () => {} })
      await reconcileEnrollments(
        { store, purger, client: expandClient, log: () => {} },
        new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
      )
      expect((await store.getEnrolledActor(FAYE))?.boundaries.sort()).toEqual(
        [BOUNTY_BOUNDARY, CREW_BOUNDARY].sort(),
      )
      vi.advanceTimersByTime(1)

      // Posts indexed under the expanded boundary while it was held.
      await store.upsertPost(post(FAYE, '1', [BOUNTY_BOUNDARY]))

      // Run 2: bounty is revoked. Because the expansion was persisted, the
      // diff sees the loss and purges the boundary's posts.
      const shrinkClient = {
        resolveEnrollments: vi.fn(async (did: string) => ({
          did,
          enrolled: true,
          boundaries: [CREW_BOUNDARY],
        })),
      }
      const summary = await reconcileEnrollments(
        { store, purger, client: shrinkClient, log: () => {} },
        new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
      )
      expect(summary.shrunk).toBe(1)
      expect(summary.postsPurged).toBe(1)
      expect(
        await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
      ).toBeNull()
      expect((await store.getEnrolledActor(FAYE))?.boundaries).toEqual([
        CREW_BOUNDARY,
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reconcile on reconnect', () => {
  it('purges an actor whose unenroll was missed during a disconnect gap', async () => {
    // The stream missed SPIKE's unenroll: the local snapshot still holds him,
    // but upstream says he is gone. The reconnect trigger must purge him.
    await store.upsertEnrolledActor(actor(SPIKE, [CREW_BOUNDARY]))
    await store.upsertPost(post(SPIKE, '1', [CREW_BOUNDARY]))
    await store.upsertCursor(SPIKE, 1, '2024-01-01T00:00:00.000Z')

    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: false,
        boundaries: [],
      })),
    }
    const removedFromPool: string[] = []
    const purger = new Purger({
      store,
      actorPool: { removeActor: (did) => removedFromPool.push(did) },
      audit: () => {},
    })
    const purgeActor = vi.spyOn(purger, 'purgeReconciledActorWithinScope')

    const trigger = createReconcileScheduler(async () => {
      await reconcileEnrollments(
        { store, purger, client, log: () => {} },
        new Set([CREW_BOUNDARY]),
      )
    })
    trigger()

    await vi.waitFor(async () =>
      expect(await store.getEnrolledActor(SPIKE)).toBeNull(),
    )
    expect(purgeActor).toHaveBeenCalledTimes(1)
    expect(purgeActor.mock.calls[0]![0].did).toBe(SPIKE)
    expect(removedFromPool).toEqual([SPIKE])
    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/1`),
    ).toBeNull()
    expect(await store.getCursor(SPIKE)).toBeNull()
  })

  it('skips the purge when a live enroll for the actor lands mid-reconcile', async () => {
    // Race: the resolve snapshot says SPIKE unenrolled, but before reconcile
    // acts on it the live stream applies his re-enroll (fresh row write).
    // Purging now would destroy live state that nothing re-adds until the
    // next reconnect.
    await store.upsertEnrolledActor(actor(SPIKE, [CREW_BOUNDARY]))
    await store.upsertPost(post(SPIKE, '1', [CREW_BOUNDARY]))

    const client = {
      resolveEnrollments: vi.fn(async (did: string) => {
        // Simulate the live enroll frame applied while the resolve is in
        // flight: the enroll path upserts the row with a current lastSeenAt.
        await store.upsertEnrolledActor({
          did: SPIKE,
          boundaries: [CREW_BOUNDARY],
          enrolledAt: '2024-01-01T00:00:00.000Z',
          lastSeenAt: new Date().toISOString(),
        })
        return { did, enrolled: false, boundaries: [] }
      }),
    }
    const purger = new Purger({ store, audit: () => {} })
    const purgeActor = vi.spyOn(purger, 'purgeReconciledActorWithinScope')

    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set([CREW_BOUNDARY]),
    )

    expect(purgeActor).not.toHaveBeenCalled()
    expect(summary.unenrolled).toBe(0)
    expect(await store.getEnrolledActor(SPIKE)).not.toBeNull()
    expect(
      await store.getPost(`at://${SPIKE}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
  })

  it('treats a row written in the same millisecond as run start as touched', async () => {
    // The live enroll frame and the reconcile run start can share one
    // millisecond, so an equal timestamp must count as touched or the purge
    // wrongly proceeds.
    vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00.000Z') })
    try {
      await store.upsertEnrolledActor(actor(SPIKE, [CREW_BOUNDARY]))

      const client = {
        resolveEnrollments: vi.fn(async (did: string) => {
          await store.upsertEnrolledActor({
            did: SPIKE,
            boundaries: [CREW_BOUNDARY],
            enrolledAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt: new Date().toISOString(),
          })
          return { did, enrolled: false, boundaries: [] }
        }),
      }
      const purger = new Purger({ store, audit: () => {} })
      const purgeActor = vi.spyOn(purger, 'purgeReconciledActorWithinScope')

      const summary = await reconcileEnrollments(
        { store, purger, client, log: () => {} },
        new Set([CREW_BOUNDARY]),
      )

      expect(purgeActor).not.toHaveBeenCalled()
      expect(summary.unenrolled).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the boundary purge when a live boundary change lands mid-reconcile', async () => {
    // Race variant: the resolve snapshot says FAYE lost bounty, but the
    // live stream re-granted it while the resolve was in flight.
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await store.upsertPost(post(FAYE, '1', [BOUNTY_BOUNDARY]))

    const client = {
      resolveEnrollments: vi.fn(async (did: string) => {
        await store.upsertEnrolledActor({
          did: FAYE,
          boundaries: [CREW_BOUNDARY, BOUNTY_BOUNDARY],
          enrolledAt: '2024-01-01T00:00:00.000Z',
          lastSeenAt: new Date().toISOString(),
        })
        return { did, enrolled: true, boundaries: [CREW_BOUNDARY] }
      }),
    }
    const purger = new Purger({ store, audit: () => {} })
    const purgeActorBoundary = vi.spyOn(
      purger,
      'purgeReconciledActorBoundaryWithinScope',
    )

    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )

    expect(purgeActorBoundary).not.toHaveBeenCalled()
    expect(summary.shrunk).toBe(0)
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
    expect((await store.getEnrolledActor(FAYE))!.boundaries.sort()).toEqual([
      BOUNTY_BOUNDARY,
      CREW_BOUNDARY,
    ])
  })

  it('gives a queued live boundary frame precedence over a stale reconcile result', async () => {
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await store.upsertPost(post(FAYE, '1', [BOUNTY_BOUNDARY]))

    const mutationFence = new SpaceMutationFence()
    const purger = new Purger({ store, mutationFence, audit: () => {} })
    let releaseDrain!: () => void
    const drainMayReturn = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    let markDrainStarted!: () => void
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve
    })
    const actorPool = {
      removeActorAndDrain: vi.fn(async () => {
        markDrainStarted()
        await drainMayReturn
      }),
      addActor: vi.fn(),
    }

    const reconcile = reconcileEnrollments(
      {
        store,
        purger,
        mutationFence,
        actorPool,
        client: {
          resolveEnrollments: async (did) => ({
            did,
            enrolled: true,
            boundaries: [CREW_BOUNDARY],
          }),
        },
        log: () => {},
      },
      new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await drainStarted

    let liveUpdateEntered = false
    mutationFence.beginDidMutation(FAYE)
    const liveUpdate = (async () => {
      try {
        await mutationFence.withDidScope(FAYE, async () => {
          liveUpdateEntered = true
          await store.upsertEnrolledActor({
            did: FAYE,
            boundaries: [CREW_BOUNDARY, BOUNTY_BOUNDARY],
            enrolledAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt: '2027-01-01T00:00:00.000Z',
          })
        })
      } finally {
        mutationFence.endDidMutation(FAYE)
      }
    })()

    try {
      await Promise.resolve()
      expect(liveUpdateEntered).toBe(false)
    } finally {
      releaseDrain()
    }

    const [summary] = await Promise.all([reconcile, liveUpdate])
    expect(summary.shrunk).toBe(0)
    expect(liveUpdateEntered).toBe(true)
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
    expect((await store.getEnrolledActor(FAYE))?.boundaries).toEqual([
      CREW_BOUNDARY,
      BOUNTY_BOUNDARY,
    ])
  })

  it('does not let unrelated live DID activity block reconciliation', async () => {
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await store.upsertPost(post(FAYE, '1', [BOUNTY_BOUNDARY]))

    const mutationFence = new SpaceMutationFence()
    const purger = new Purger({ store, mutationFence, audit: () => {} })
    mutationFence.beginDidMutation(SPIKE)
    try {
      const summary = await reconcileEnrollments(
        {
          store,
          purger,
          mutationFence,
          client: {
            resolveEnrollments: async (did) => ({
              did,
              enrolled: true,
              boundaries: [CREW_BOUNDARY],
            }),
          },
          log: () => {},
        },
        new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
      )

      expect(summary.shrunk).toBe(1)
      expect(
        await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
      ).toBeNull()
    } finally {
      mutationFence.endDidMutation(SPIKE)
    }
  })

  it('rolls back an in-flight boundary purge when a live frame becomes pending', async () => {
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await store.upsertPost(post(FAYE, '1', [BOUNTY_BOUNDARY]))
    await store.upsertSpaceCursor(
      BOUNTY_SPACE,
      FAYE,
      'rev-7',
      '2024-01-01T00:00:00.000Z',
    )

    const mutationFence = new SpaceMutationFence()
    const audits: PurgeAudit[] = []
    const purger = new Purger({
      store,
      mutationFence,
      audit: (entry) => audits.push(entry),
    })
    const originalGuardedDelete =
      store.deleteActorBoundaryStateGuarded.bind(store)
    let liveUpdate: Promise<void> | undefined
    vi.spyOn(store, 'deleteActorBoundaryStateGuarded').mockImplementation(
      (spaceUri, did, boundary, shouldCommit) =>
        originalGuardedDelete(spaceUri, did, boundary, () => {
          mutationFence.beginDidMutation(FAYE)
          liveUpdate = (async () => {
            try {
              await mutationFence.withDidScope(FAYE, async () => {
                await store.upsertEnrolledActor({
                  did: FAYE,
                  boundaries: [CREW_BOUNDARY, BOUNTY_BOUNDARY],
                  enrolledAt: '2024-01-01T00:00:00.000Z',
                  lastSeenAt: '2027-01-01T00:00:00.000Z',
                })
              })
            } finally {
              mutationFence.endDidMutation(FAYE)
            }
          })()
          return shouldCommit()
        }),
    )

    const summary = await reconcileEnrollments(
      {
        store,
        purger,
        mutationFence,
        actorPool: {
          removeActorAndDrain: vi.fn(async () => {}),
          addActor: vi.fn(),
        },
        client: {
          resolveEnrollments: async (did) => ({
            did,
            enrolled: true,
            boundaries: [CREW_BOUNDARY],
          }),
        },
        log: () => {},
      },
      new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    if (!liveUpdate) throw new Error('live update was not queued')
    await liveUpdate

    expect(summary.shrunk).toBe(0)
    expect(summary.postsPurged).toBe(0)
    expect(audits).toEqual([])
    expect(
      await store.getPost(`at://${FAYE}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
    expect(await store.getSpaceCursor(BOUNTY_SPACE, FAYE)).toBe('rev-7')
    expect((await store.getEnrolledActor(FAYE))?.boundaries).toEqual([
      CREW_BOUNDARY,
      BOUNTY_BOUNDARY,
    ])
  })

  it('propagates a guarded boundary-delete failure without auditing success', async () => {
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    const mutationFence = new SpaceMutationFence()
    const audits: PurgeAudit[] = []
    const purger = new Purger({
      store,
      mutationFence,
      audit: (entry) => audits.push(entry),
    })
    const deleteError = new Error('boundary transaction failed')
    vi.spyOn(store, 'deleteActorBoundaryStateGuarded').mockRejectedValueOnce(
      deleteError,
    )

    await expect(
      reconcileEnrollments(
        {
          store,
          purger,
          mutationFence,
          client: {
            resolveEnrollments: async (did) => ({
              did,
              enrolled: true,
              boundaries: [CREW_BOUNDARY],
            }),
          },
          log: () => {},
        },
        new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
      ),
    ).rejects.toBe(deleteError)
    expect(audits).toEqual([])
    expect((await store.getEnrolledActor(FAYE))?.boundaries).toEqual([
      CREW_BOUNDARY,
      BOUNTY_BOUNDARY,
    ])
  })

  it('skips the purge when a live unenroll already removed the actor mid-reconcile', async () => {
    // The live unenroll frame won the race and fully purged SPIKE; a second
    // purge for a missing row must be skipped rather than re-run or crash.
    await store.upsertEnrolledActor(actor(SPIKE, [CREW_BOUNDARY]))

    const client = {
      resolveEnrollments: vi.fn(async (did: string) => {
        await store.deleteEnrolledActor(SPIKE)
        return { did, enrolled: false, boundaries: [] }
      }),
    }
    const purger = new Purger({ store, audit: () => {} })
    const purgeActor = vi.spyOn(purger, 'purgeReconciledActorWithinScope')

    const summary = await reconcileEnrollments(
      { store, purger, client, log: () => {} },
      new Set([CREW_BOUNDARY]),
    )

    expect(purgeActor).not.toHaveBeenCalled()
    expect(summary.unenrolled).toBe(0)
  })

  it('never purges actors upstream still reports enrolled', async () => {
    // Safety property: reconciliation diffs against authoritative per-DID
    // resolves, never against the replay stream, so an active actor survives
    // no matter when the trigger fires relative to replay.
    await store.upsertEnrolledActor(actor(VASH, [CREW_BOUNDARY]))
    await store.upsertEnrolledActor(
      actor(FAYE, [CREW_BOUNDARY, BOUNTY_BOUNDARY]),
    )
    await store.upsertPost(post(VASH, '1', [CREW_BOUNDARY]))

    const boundaries: Record<string, string[]> = {
      [VASH]: [CREW_BOUNDARY],
      [FAYE]: [CREW_BOUNDARY, BOUNTY_BOUNDARY],
    }
    const client = {
      resolveEnrollments: vi.fn(async (did: string) => ({
        did,
        enrolled: true,
        boundaries: boundaries[did],
      })),
    }
    const purger = new Purger({ store, audit: () => {} })
    const purgeActor = vi.spyOn(purger, 'purgeReconciledActorWithinScope')

    const runs: unknown[] = []
    const trigger = createReconcileScheduler(async () => {
      const summary = await reconcileEnrollments(
        { store, purger, client, log: () => {} },
        new Set([CREW_BOUNDARY, BOUNTY_BOUNDARY]),
      )
      runs.push(summary)
    })
    trigger()

    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(client.resolveEnrollments).toHaveBeenCalledTimes(2)
    expect(purgeActor).not.toHaveBeenCalled()
    expect(await store.getEnrolledActor(VASH)).not.toBeNull()
    expect(await store.getEnrolledActor(FAYE)).not.toBeNull()
    expect(
      await store.getPost(`at://${VASH}/zone.stratos.feed.post/1`),
    ).not.toBeNull()
  })
})
