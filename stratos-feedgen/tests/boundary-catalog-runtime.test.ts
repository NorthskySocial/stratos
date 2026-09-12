import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteDb,
  migrateSqliteDb,
  SqliteFeedgenStore,
  type FeedgenStore,
} from '../src/db/index.js'
import { BoundaryCatalogRuntime } from '../src/feeds/catalog-runtime.js'
import type { CatalogBoundary } from '../src/feeds/catalog-model.js'
import { SpaceMutationFence } from '../src/mutation-fence.js'
import { Purger, reconcileEnrollments } from '../src/purge/index.js'
import { CurrentMembershipReplayAuthorizer } from '../src/subscription/replay-authorizer.js'
import { SubscriptionIndexer } from '../src/subscription/indexer.js'

const AUTHORITY = 'did:web:nerv.example'
const REI = 'did:plc:rei'
const ASUKA = 'did:plc:asuka'
const PILOTS = `${AUTHORITY}/pilots`
const COMMAND = `${AUTHORITY}/command`
const time = '2020-01-01T00:00:00.000Z'
const row = (boundary: string, revision = 1): CatalogBoundary => ({
  boundary,
  roomId: boundary.split('/').at(-1)!,
  displayName: 'NERV',
  description: 'Pilots',
  listed: true,
  joinable: true,
  revision,
})
const controller = () => new AbortController()
let store: FeedgenStore

beforeEach(async () => {
  const db = createSqliteDb(':memory:')
  await migrateSqliteDb(db)
  store = new SqliteFeedgenStore(db)
})
afterEach(async () => {
  await store.close()
})

function fixture() {
  const configuredBoundaries = new Set<string>()
  const remote = new Map([
    [REI, [PILOTS]],
    [ASUKA, [COMMAND]],
  ])
  const client = {
    resolveEnrollments: vi.fn(async (did: string) => ({
      did,
      enrolled: remote.has(did),
      boundaries: remote.get(did) ?? [],
    })),
  }
  const actorPool = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    seedFromStore: vi.fn(async (_boundaries: Set<string>) => 1),
    addActor: vi.fn(),
    removeActorAndDrain: vi.fn(async () => {}),
  }
  const purger = new Purger({
    store,
    mutationFence: new SpaceMutationFence(),
    audit: vi.fn(),
  })
  const scheduler = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    abortActivePass: vi.fn(),
  }
  const membership = {
    runPass: vi.fn(async (boundaries: Iterable<string>) => {
      for (const boundary of boundaries) {
        await store.replaceSpaceMembers(
          boundary,
          [...remote]
            .filter(([, held]) => held.includes(boundary))
            .map(([did]) => ({ did, custody: 'stratos' as const })),
        )
      }
      return []
    }),
  }
  const enrollment = { clear: vi.fn() }
  const credentials = { clear: vi.fn() }
  const blobs = { clear: vi.fn(async () => {}) }
  const reconcile = vi.fn(async (signal: AbortSignal) => {
    const result = await reconcileEnrollments(
      {
        store,
        purger,
        actorPool,
        client,
        signal,
        log: vi.fn(),
        onError: vi.fn(),
      },
      configuredBoundaries,
    )
    return result.errors === 0 && !result.truncated
  })
  const createSpaces = vi.fn(() => ({ membership, scheduler }))
  const deps = {
    store,
    configuredBoundaries,
    enrollment,
    credentials,
    blobs,
    purger: () => purger,
    subscription: () => ({ actorPool, reconcile }),
    createSpaces,
    spaceSyncEnabled: true,
  }
  const runtime = new BoundaryCatalogRuntime(deps)
  return {
    runtime,
    deps,
    remote,
    configuredBoundaries,
    client,
    actorPool,
    scheduler,
    membership,
    enrollment,
    credentials,
    blobs,
    reconcile,
    createSpaces,
  }
}

async function post(did: string, boundary: string) {
  await store.upsertPost({
    uri: `at://${did}/zone.stratos.feed.post/first`,
    did,
    cid: 'bafyrei',
    sortAt: time,
    indexedAt: time,
    record: { $type: 'zone.stratos.feed.post', text: 'NERV' },
    blobRefs: [],
    boundaries: [boundary],
  })
}
async function enroll(did: string, boundaries: string[]) {
  await store.upsertEnrolledActor({
    did,
    boundaries,
    enrolledAt: time,
    lastSeenAt: time,
  })
}

describe('catalogue projection transitions', () => {
  it('discovers missing actors, reconciles authority, resets replay cursors, and indexes the new scope', async () => {
    const {
      runtime,
      actorPool,
      scheduler,
      configuredBoundaries,
      client,
      blobs,
    } = fixture()
    await enroll(REI, [PILOTS])
    const bootstrap = vi.spyOn(store, 'upsertEnrolledActor')
    await store.upsertCursor(ASUKA, 99, time)
    const authorizer = new CurrentMembershipReplayAuthorizer({
      configuredBoundaries,
      client,
    })
    expect(await authorizer.authorize(ASUKA, [COMMAND])).toEqual([])
    await runtime.suspend()
    await runtime.apply(
      [row(PILOTS)],
      [row(PILOTS), row(COMMAND)],
      controller().signal,
    )
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        did: ASUKA,
        boundaries: [],
        lastSeenAt: '1970-01-01T00:00:00.000Z',
      }),
    )
    expect((await store.getEnrolledActor(ASUKA))?.boundaries).toEqual([COMMAND])
    expect(await store.getCursor(ASUKA)).toBeNull()
    expect([...configuredBoundaries]).toEqual([PILOTS, COMMAND])
    expect(actorPool.seedFromStore).toHaveBeenCalledWith(configuredBoundaries)
    expect(actorPool.start).toHaveBeenCalledOnce()
    expect(scheduler.start).toHaveBeenCalledOnce()
    expect(blobs.clear).toHaveBeenCalledOnce()
    const indexer = new SubscriptionIndexer(store, {
      replayAuthorizer: authorizer,
    })
    await indexer.applyCommit({
      did: ASUKA,
      seq: 1,
      time,
      ops: [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/new',
          cid: 'bafyasuka',
          record: {
            $type: 'zone.stratos.feed.post',
            text: 'Asuka',
            boundary: { values: [{ value: COMMAND }] },
          },
        },
      ],
    })
    expect(
      (await store.getPost(`at://${ASUKA}/zone.stratos.feed.post/new`))
        ?.boundaries,
    ).toEqual([COMMAND])
    configuredBoundaries.clear()
    expect(await authorizer.authorize(ASUKA, [COMMAND])).toEqual([])
  })

  it('purges an offline-removed scope found only in the index, including orphaned membership snapshots', async () => {
    const { runtime, remote } = fixture()
    remote.delete(ASUKA)
    await post(ASUKA, COMMAND)
    await post(REI, PILOTS)
    await store.replaceSpaceMembers(COMMAND, [
      { did: ASUKA, custody: 'pds', host: 'https://asuka.example' },
    ])
    expect(await store.listIndexedBoundaries()).toEqual([COMMAND, PILOTS])
    await runtime.suspend()
    await runtime.apply([], [row(PILOTS)], controller().signal)
    expect(await store.listIndexedBoundaries()).toEqual([])
    expect(await store.listSpaceMembers(COMMAND)).toEqual([])
    expect(
      await store.getPost(`at://${ASUKA}/zone.stratos.feed.post/first`),
    ).toBeNull()
  })

  it('resets both actors gaining and actors losing a changed boundary after current-authority reconciliation', async () => {
    const { runtime, remote } = fixture()
    await enroll(REI, [PILOTS, COMMAND])
    await enroll(ASUKA, [PILOTS])
    remote.set(REI, [PILOTS])
    remote.set(ASUKA, [PILOTS, COMMAND])
    await store.upsertCursor(REI, 10, time)
    await store.upsertCursor(ASUKA, 20, time)
    await runtime.apply(
      [row(PILOTS), row(COMMAND)],
      [row(PILOTS), row(COMMAND, 2)],
      controller().signal,
    )
    expect(await store.getCursor(REI)).toBeNull()
    expect(await store.getCursor(ASUKA)).toBeNull()
  })

  it('keeps unrelated actor cursors and still refreshes membership when recovering unchanged catalogue state', async () => {
    const { runtime, remote, createSpaces, membership } = fixture()
    remote.delete(ASUKA)
    await enroll(REI, [PILOTS])
    await store.upsertCursor(REI, 10, time)
    await post(REI, PILOTS)
    await runtime.apply([row(PILOTS)], [row(PILOTS)], controller().signal)
    expect(await store.listIndexedBoundaries()).toEqual([PILOTS])
    expect(await store.getCursor(REI)).toBe(10)
    await runtime.suspend()
    await runtime.apply([row(PILOTS)], [row(PILOTS)], controller().signal)
    expect(createSpaces).toHaveBeenCalledTimes(2)
    expect(membership.runPass).toHaveBeenCalledTimes(2)
  })

  it('resets existing members when their already-held scope becomes newly served', async () => {
    const { runtime } = fixture()
    await enroll(ASUKA, [COMMAND])
    await store.upsertCursor(ASUKA, 99, time)
    await runtime.apply(
      [row(PILOTS)],
      [row(PILOTS), row(COMMAND)],
      controller().signal,
    )
    expect(await store.getCursor(ASUKA)).toBeNull()
  })

  it('aborts and drains active sync writers before clearing held credentials', async () => {
    const { runtime, scheduler, actorPool, credentials, enrollment } = fixture()
    await runtime.apply([], [row(PILOTS)], controller().signal)
    await runtime.suspend()
    expect(scheduler.abortActivePass).toHaveBeenCalledOnce()
    expect(scheduler.stop).toHaveBeenCalledOnce()
    expect(actorPool.stop).toHaveBeenCalledOnce()
    expect(credentials.clear).toHaveBeenCalledOnce()
    expect(enrollment.clear).toHaveBeenCalledOnce()
    expect(credentials.clear.mock.invocationCallOrder[0]).toBeGreaterThan(
      scheduler.stop.mock.invocationCallOrder[0],
    )
  })

  it('requires a complete membership enumeration before discovering actors or restarting sync', async () => {
    const { runtime, membership, actorPool } = fixture()
    membership.runPass.mockResolvedValueOnce([
      { boundary: PILOTS, ok: false, polls: [], error: new Error('offline') },
    ] as never)
    await expect(
      runtime.apply([], [row(PILOTS)], controller().signal),
    ).rejects.toThrow('Boundary membership discovery is incomplete')
    expect(await store.getEnrolledActor(REI)).toBeNull()
    expect(actorPool.start).not.toHaveBeenCalled()
  })

  it('does not resume incomplete reconciliation and succeeds after retry', async () => {
    const { runtime, reconcile, actorPool } = fixture()
    reconcile.mockResolvedValueOnce(false)
    await expect(
      runtime.apply([], [row(PILOTS)], controller().signal),
    ).rejects.toThrow('Boundary enrollment reconciliation is incomplete')
    expect(actorPool.start).not.toHaveBeenCalled()
    await runtime.apply([], [row(PILOTS)], controller().signal)
    expect(actorPool.start).toHaveBeenCalledOnce()
  })

  it('requires the enrollment subscription even when membership enumeration succeeds', async () => {
    const { deps, actorPool } = fixture()
    const runtime = new BoundaryCatalogRuntime({
      ...deps,
      subscription: () => null,
    })
    await runtime.suspend()
    await expect(runtime.apply([], [], controller().signal)).rejects.toThrow(
      'Boundary enrollment reconciliation is incomplete',
    )
    expect(actorPool.start).not.toHaveBeenCalled()
  })

  it('can discover Stratos-hosted members while scheduled PDS sync is disabled', async () => {
    const { deps, scheduler } = fixture()
    const runtime = new BoundaryCatalogRuntime({
      ...deps,
      spaceSyncEnabled: false,
    })
    await runtime.apply([], [row(PILOTS)], controller().signal)
    expect(await store.getEnrolledActor(REI)).not.toBeNull()
    expect(scheduler.start).not.toHaveBeenCalled()
  })

  it('cancellation before and during reconciliation never restarts drained workers', async () => {
    const { runtime, reconcile, actorPool } = fixture()
    const first = controller()
    first.abort()
    await expect(
      runtime.apply([], [row(PILOTS)], first.signal),
    ).rejects.toThrow()
    const second = controller()
    reconcile.mockImplementationOnce(async () => {
      second.abort()
      return true
    })
    await expect(
      runtime.apply([], [row(PILOTS)], second.signal),
    ).rejects.toThrow()
    expect(actorPool.start).not.toHaveBeenCalled()
  })
})
