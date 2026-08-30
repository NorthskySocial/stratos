import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteDb,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import {
  SpaceSyncer,
  SpaceSyncRunner,
  SpaceSyncScheduler,
  type BoundaryPassOutcome,
  type BoundaryPassSuccess,
  type PollTarget,
  type SpaceSyncRunResult,
} from '../src/space-sync/index.js'

// 90s-anime crew DIDs and boundaries, matching the other space-sync fixtures.
const STRATOS_DID = 'did:web:stratos.test'
const BEBOP_BOUNDARY = `${STRATOS_DID}/bebop-crew`
const SPACE_URI = `at://${STRATOS_DID}/space/zone.stratos.space.feed/bebop-crew`
const SPIKE_DID = 'did:plc:spikespiegel'
const FAYE_DID = 'did:plc:fayevalentine'
const JET_DID = 'did:plc:jetblack'
const HOST = 'https://spike.example'
const POST_COLLECTION = 'zone.stratos.feed.post'

function makeTarget(overrides: Partial<PollTarget> = {}): PollTarget {
  return {
    spaceUri: SPACE_URI,
    boundary: BEBOP_BOUNDARY,
    did: SPIKE_DID,
    host: HOST,
    ...overrides,
  }
}

function successOutcome(polls: PollTarget[]): BoundaryPassSuccess {
  return {
    boundary: BEBOP_BOUNDARY,
    ok: true,
    polls,
    skippedNoHost: 0,
    removed: [],
  }
}

function runSuccess(target: PollTarget): SpaceSyncRunResult {
  return {
    target,
    ok: true,
    pagesFetched: 1,
    recordsIndexed: 1,
    recordsDeleted: 0,
    skippedOversized: 0,
    skippedMalformed: 0,
    stopReason: 'complete',
  }
}

/** Polls a real-timer predicate. Used only by the test that needs real I/O. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: condition not met before timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fakeMembership(outcomes: BoundaryPassOutcome[] = []) {
  return {
    runPass: vi.fn(
      async (_boundaries: Iterable<string>): Promise<BoundaryPassOutcome[]> =>
        outcomes,
    ),
  }
}

function fakeRunner() {
  return {
    runTarget: vi.fn(
      async (target: PollTarget): Promise<SpaceSyncRunResult> =>
        runSuccess(target),
    ),
  }
}

describe('SpaceSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a pass once the interval elapses, and reports the tally', async () => {
    const spike = makeTarget({ did: SPIKE_DID })
    const membership = fakeMembership([successOutcome([spike])])
    const runner = fakeRunner()
    const boundaries = new Set([BEBOP_BOUNDARY])
    const log = vi.fn()

    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries,
      intervalMs: 10_000,
      random: () => 0.5,
      log,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(membership.runPass).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(membership.runPass).toHaveBeenCalledExactlyOnceWith(boundaries)
    expect(runner.runTarget).toHaveBeenCalledExactlyOnceWith(
      spike,
      expect.any(AbortSignal),
    )
    expect(log).toHaveBeenCalledExactlyOnceWith({
      targets: 1,
      succeeded: 1,
      failed: 0,
      abandoned: 0,
      halted: 0,
    })

    await scheduler.stop()
  })

  it('applies symmetric jitter around intervalMs, driven by the injected random source', async () => {
    const runner = fakeRunner()

    // random()=0 -> minimum jitter: fires at 9000ms, not a tick earlier.
    const low = fakeMembership()
    const lowScheduler = new SpaceSyncScheduler({
      membership: low,
      runner,
      boundaries: [],
      intervalMs: 10_000,
      random: () => 0,
    })
    lowScheduler.start()
    await vi.advanceTimersByTimeAsync(8_999)
    expect(low.runPass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(low.runPass).toHaveBeenCalledOnce()
    await lowScheduler.stop()

    // random()=1 -> maximum jitter: fires at 11000ms, not at the bare interval.
    const high = fakeMembership()
    const highScheduler = new SpaceSyncScheduler({
      membership: high,
      runner,
      boundaries: [],
      intervalMs: 10_000,
      random: () => 1,
    })
    highScheduler.start()
    await vi.advanceTimersByTimeAsync(10_999)
    expect(high.runPass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(high.runPass).toHaveBeenCalledOnce()
    await highScheduler.stop()

    // random()=0.5 -> zero jitter: fires at exactly intervalMs.
    const mid = fakeMembership()
    const midScheduler = new SpaceSyncScheduler({
      membership: mid,
      runner,
      boundaries: [],
      intervalMs: 10_000,
      random: () => 0.5,
    })
    midScheduler.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(mid.runPass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mid.runPass).toHaveBeenCalledOnce()
    await midScheduler.stop()
  })

  it('skips an overlapping tick instead of queuing a follow-up run', async () => {
    const gate = deferred<BoundaryPassOutcome[]>()
    const membership = { runPass: vi.fn(async () => gate.promise) }
    const runner = fakeRunner()
    const onTickSkipped = vi.fn()

    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      random: () => 0.5,
      onTickSkipped,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(membership.runPass).toHaveBeenCalledOnce()

    // Two more ticks land while the first pass is still in flight.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onTickSkipped).toHaveBeenCalledOnce()
    expect(membership.runPass).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onTickSkipped).toHaveBeenCalledTimes(2)
    expect(membership.runPass).toHaveBeenCalledOnce()

    // Freeing the in-flight pass must not itself trigger a follow-up: the
    // skipped ticks were dropped, not coalesced into a queued rerun.
    gate.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(membership.runPass).toHaveBeenCalledOnce()

    // Only the next tick on the regular cadence starts a second pass.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(membership.runPass).toHaveBeenCalledTimes(2)

    await scheduler.stop()
  })

  it('abandons a member over its time budget so the pass completes without it', async () => {
    const spike = makeTarget({ did: SPIKE_DID })
    const faye = makeTarget({ did: FAYE_DID })
    const jet = makeTarget({ did: JET_DID })
    const membership = fakeMembership([successOutcome([spike, faye, jet])])

    const jetGate = deferred<SpaceSyncRunResult>()
    const runTarget = vi.fn(
      async (target: PollTarget): Promise<SpaceSyncRunResult> => {
        if (target.did === JET_DID) return jetGate.promise
        return runSuccess(target)
      },
    )
    const onMemberBudgetExceeded = vi.fn()
    const onError = vi.fn()
    const log = vi.fn()

    const scheduler = new SpaceSyncScheduler({
      membership,
      runner: { runTarget },
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      // Deliberately not a multiple of intervalMs: the abandon deadline
      // (dispatch time + budget) must not land on the same tick boundary as
      // the next scheduled pass, or the two same-instant timers race and a
      // second pass starts before this test can observe the first outcome.
      memberBudgetMs: 2_500,
      random: () => 0.5,
      onMemberBudgetExceeded,
      onError,
      log,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(1_000)
    // All three members are dispatched concurrently — Jet hanging does not
    // block Spike or Faye from even starting.
    expect(runTarget).toHaveBeenCalledTimes(3)
    expect(onMemberBudgetExceeded).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_499)
    expect(onMemberBudgetExceeded).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onMemberBudgetExceeded).toHaveBeenCalledExactlyOnceWith(jet)
    expect(log).toHaveBeenCalledExactlyOnceWith({
      targets: 3,
      succeeded: 2,
      failed: 0,
      abandoned: 1,
      halted: 0,
    })

    // Jet's own call finishing late, after abandonment, must not surface as
    // an error or otherwise disturb the (already-reported) pass.
    jetGate.resolve(runSuccess(jet))
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()

    await scheduler.stop()
  })

  it('leaves no trace of a member sync past the point its budget aborted it', async () => {
    // Real timers: this test drives a real SpaceSyncer/SpaceSyncRunner pair
    // against a real SQLite store, and libsql's async I/O is not driven by
    // vitest's fake-timer microtask flushing.
    vi.useRealTimers()
    const dir = await mkdtemp(join(tmpdir(), 'feedgen-scheduler-'))
    const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
    await migrateSqliteDb(db)
    const store = new SqliteFeedgenStore(db)
    try {
      const spike = makeTarget({ did: SPIKE_DID })
      const jet = makeTarget({ did: JET_DID })
      const membership = fakeMembership([successOutcome([spike, jet])])

      // Jet's host answers page one (one post, non-terminal cursor) so real
      // progress lands in the store, then hangs on page two exactly like an
      // unreachable fetch would — it only settles once the caller's own
      // signal aborts it, same as a real fetch under `AbortSignal.any`.
      const jetHostClient = {
        listRepoOps: vi.fn(
          async (opts: { cursor?: string; signal?: AbortSignal }) => {
            if (opts.cursor === undefined) {
              return {
                ops: [
                  {
                    rev: '1',
                    collection: POST_COLLECTION,
                    rkey: 'r1',
                    cid: 'cid-1',
                    value: { $type: POST_COLLECTION, text: 'partial' },
                  },
                ],
                cursor: 'page-2',
              }
            }
            return new Promise<never>((_resolve, reject) => {
              opts.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              )
            })
          },
        ),
        getRecord: vi.fn(),
      }
      const refuses = (label: string) =>
        vi.fn(() => {
          throw new Error(`${label} must not run for an abandoned member`)
        })
      const jetRunner = new SpaceSyncRunner({
        syncer: new SpaceSyncer({
          store,
          credentialManager: {
            getCredential: vi.fn(async (boundary: string) => ({
              boundary,
              spaceUri: SPACE_URI,
              credential: `cred-${boundary}`,
              expiresAt: new Date(Date.now() + 3_600_000),
              createPresentationProof: async () => 'proof',
            })),
          },
          createHostClient: () => jetHostClient,
          onError: vi.fn(),
        }),
        // A member cut short by its budget never reaches a terminal page, so
        // neither verification nor a purge should ever run for it.
        verifier: { verify: refuses('verify') },
        purger: { purgeActorBoundary: refuses('purgeActorBoundary') },
      })

      const runTarget = vi.fn(
        async (
          target: PollTarget,
          signal?: AbortSignal,
        ): Promise<SpaceSyncRunResult> => {
          if (target.did === JET_DID) {
            return jetRunner.runTarget(target, signal)
          }
          return runSuccess(target)
        },
      )
      const onMemberBudgetExceeded = vi.fn()

      const scheduler = new SpaceSyncScheduler({
        membership,
        runner: { runTarget },
        boundaries: [BEBOP_BOUNDARY],
        intervalMs: 50,
        memberBudgetMs: 60,
        onMemberBudgetExceeded,
      })
      scheduler.start()

      // Stop the instant the first abandonment lands, before the next tick
      // can start a second pass and call it again.
      await waitUntil(() => onMemberBudgetExceeded.mock.calls.length > 0)
      await scheduler.stop()

      expect(onMemberBudgetExceeded).toHaveBeenCalledExactlyOnceWith(jet)
      // Page one's write landed before the abort.
      expect(
        await store.getPost(`${SPACE_URI}/${JET_DID}/${POST_COLLECTION}/r1`),
      ).not.toBeNull()
      expect(await store.getSpaceCursor(SPACE_URI, JET_DID)).toBe('page-2')
    } finally {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts a halted runner result separately from a failure', async () => {
    const spike = makeTarget({ did: SPIKE_DID })
    const membership = fakeMembership([successOutcome([spike])])
    const runTarget = vi.fn(
      async (): Promise<SpaceSyncRunResult> => ({
        target: spike,
        ok: false,
        reason: 'halted',
      }),
    )
    const log = vi.fn()

    const scheduler = new SpaceSyncScheduler({
      membership,
      runner: { runTarget },
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      random: () => 0.5,
      log,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(log).toHaveBeenCalledExactlyOnceWith({
      targets: 1,
      succeeded: 0,
      failed: 0,
      abandoned: 0,
      halted: 1,
    })

    await scheduler.stop()
  })

  it('stop() resolves only after the in-flight pass settles, and no tick fires afterwards', async () => {
    const gate = deferred<BoundaryPassOutcome[]>()
    const membership = { runPass: vi.fn(async () => gate.promise) }
    const runner = fakeRunner()

    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      random: () => 0.5,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(membership.runPass).toHaveBeenCalledOnce()

    let stopSettled = false
    const stopping = scheduler.stop().then(() => {
      stopSettled = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(stopSettled).toBe(false)

    gate.resolve([])
    await stopping
    expect(stopSettled).toBe(true)

    await vi.advanceTimersByTimeAsync(100_000)
    expect(membership.runPass).toHaveBeenCalledOnce()
  })

  it('stop() gives up after stopGraceMs when the in-flight pass never settles', async () => {
    const gate = deferred<BoundaryPassOutcome[]>()
    const membership = { runPass: vi.fn(async () => gate.promise) }
    const runner = fakeRunner()
    const onStopTimedOut = vi.fn()

    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      random: () => 0.5,
      stopGraceMs: 500,
      onStopTimedOut,
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(membership.runPass).toHaveBeenCalledOnce()

    let stopSettled = false
    const stopping = scheduler.stop().then(() => {
      stopSettled = true
    })

    await vi.advanceTimersByTimeAsync(499)
    expect(stopSettled).toBe(false)
    expect(onStopTimedOut).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(stopSettled).toBe(true)
    expect(onStopTimedOut).toHaveBeenCalledOnce()

    // The wedged pass is left to settle on its own, unobserved — resolving
    // it late must not throw or otherwise surface after stop() gave up.
    gate.resolve([])
    await vi.advanceTimersByTimeAsync(0)
  })

  it('stop() before start() resolves immediately without side effects', async () => {
    const membership = fakeMembership()
    const runner = fakeRunner()
    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries: [BEBOP_BOUNDARY],
    })

    await scheduler.stop()
    expect(membership.runPass).not.toHaveBeenCalled()
  })

  it('start() is idempotent: a second call does not arm a duplicate tick chain', async () => {
    const membership = fakeMembership()
    const runner = fakeRunner()
    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      random: () => 0.5,
    })

    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(membership.runPass).toHaveBeenCalledOnce()

    await scheduler.stop()
  })

  it('reports a membership.runPass rejection via onError and retries on the next tick', async () => {
    const failure = new Error('upstream unreachable')
    const runPass = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue([])
    const runner = fakeRunner()
    const onError = vi.fn()
    const log = vi.fn()

    const scheduler = new SpaceSyncScheduler({
      membership: { runPass },
      runner,
      boundaries: [BEBOP_BOUNDARY],
      intervalMs: 1_000,
      random: () => 0.5,
      onError,
      log,
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(log).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(runPass).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledExactlyOnceWith({
      targets: 0,
      succeeded: 0,
      failed: 0,
      abandoned: 0,
      halted: 0,
    })

    await scheduler.stop()
  })
})
