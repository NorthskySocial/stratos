import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
    expect(runner.runTarget).toHaveBeenCalledExactlyOnceWith(spike)
    expect(log).toHaveBeenCalledExactlyOnceWith({
      targets: 1,
      succeeded: 1,
      failed: 0,
      abandoned: 0,
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

  it('abandons a member over its time budget so the pass completes without it, cursor untouched', async () => {
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
    })

    // Jet's own call finishing late, after abandonment, must not surface as
    // an error or otherwise disturb the (already-reported) pass.
    jetGate.resolve(runSuccess(jet))
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()

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
    })

    await scheduler.stop()
  })
})
