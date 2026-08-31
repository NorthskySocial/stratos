import type { MembershipTracker, PollTarget } from './membership.js'
import type { SpaceSyncRunner, SpaceSyncRunResult } from './sync-runner.js'

/**
 * Fraction of `intervalMs` used as symmetric jitter, so many feedgens on the
 * same interval don't all poll the same instant. Matches
 * `space-credential/manager.ts`'s desync rationale.
 */
const JITTER_FRACTION = 0.1

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_MEMBER_BUDGET_MS = 60_000
const DEFAULT_MEMBER_CONCURRENCY = 8

export interface SpaceSyncPassLogEvent {
  /** Poll targets produced by this pass's membership run. */
  targets: number
  /** Targets whose sync completed within budget and reported success. */
  succeeded: number
  /** Targets whose sync completed within budget but reported failure. */
  failed: number
  /** Targets abandoned for exceeding the member time budget this pass. */
  abandoned: number
  /** Targets skipped with no network call because they are in a halt cooldown. */
  halted: number
}

export interface SpaceSyncSchedulerDeps {
  membership: Pick<MembershipTracker, 'runPass'>
  runner: Pick<SpaceSyncRunner, 'completeMembershipPass' | 'runTarget'>
  /**
   * Boundaries polled each pass. Pass the same live boundary `Set` the rest
   * of the feedgen uses — each pass reads it fresh, so mutating it in place
   * is picked up on the next pass with no extra wiring.
   */
  boundaries: Iterable<string>
  /** Target interval (ms) between passes, before jitter. Default 30000. */
  intervalMs?: number
  /** Time budget (ms) for one member's sync within a pass. Default 60000. */
  memberBudgetMs?: number
  /** Maximum number of member syncs active within one pass. Default 8. */
  memberConcurrency?: number
  /**
   * Structured per-pass summary sink. Called once per pass that starts.
   * Unlike its siblings elsewhere in `space-sync/`, this has no `console.*`
   * default — the scheduler never logs on its own.
   */
  log?: (event: SpaceSyncPassLogEvent) => void
  /** Called once per tick that arrives while the previous pass is still in flight. That tick is skipped, not queued. */
  onTickSkipped?: () => void
  /** Called once per member abandoned this pass for exceeding `memberBudgetMs`. */
  onMemberBudgetExceeded?: (target: PollTarget) => void
  /** Called for a failure outside the per-member result channel: `membership.runPass` rejecting, or an injected callback throwing. */
  onError?: (err: unknown) => void
  /** Injectable jitter source, `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number
}

type MemberPollOutcome =
  | { status: 'completed'; result: SpaceSyncRunResult }
  | { status: 'abandoned' }
  | { status: 'errored' }

/**
 * Jittered fixed-interval loop driving one space-sync pass: a membership
 * pass (WP3) followed by one `runner.runTarget` call (WP4+WP5) per poll
 * target it produces.
 *
 * Two concurrency guards, both required by the sync's own idempotence:
 *
 * - **Overlap is skipped, not queued.** A tick that lands while the
 *   previous pass is still running calls `onTickSkipped` and does nothing
 *   else. The next tick is scheduled independently of pass duration, so a
 *   slow pass costs skipped ticks, never a stacked backlog of concurrent
 *   passes against the same upstream.
 * - **A hung member cannot stall the pass.** A member over `memberBudgetMs`
 *   is abandoned: the pass reports it via `onMemberBudgetExceeded` and moves
 *   on. Abandonment aborts the `AbortSignal` passed into `runner.runTarget`,
 *   so the underlying sync stops at its next checkpoint instead of running
 *   to completion unobserved — the next pass retries it from wherever it
 *   last completed, never from a state the abandoned call raced past.
 *
 * `stop()` drains the in-flight pass and every raw member sync. Shutdown can
 * call `abortActivePass()` at its deadline, but still keeps the store open
 * until work that ignores cancellation settles.
 */
export class SpaceSyncScheduler {
  private readonly membership: SpaceSyncSchedulerDeps['membership']
  private readonly runner: SpaceSyncSchedulerDeps['runner']
  private readonly boundaries: Iterable<string>
  private readonly intervalMs: number
  private readonly memberBudgetMs: number
  private readonly memberConcurrency: number
  private readonly log: (event: SpaceSyncPassLogEvent) => void
  private readonly onTickSkipped: () => void
  private readonly onMemberBudgetExceeded: (target: PollTarget) => void
  private readonly onError: (err: unknown) => void
  private readonly random: () => number

  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private readonly activeRunnerCalls = new Set<Promise<SpaceSyncRunResult>>()
  private activePassController: AbortController | null = null
  private stopped = true

  constructor(deps: SpaceSyncSchedulerDeps) {
    this.membership = deps.membership
    this.runner = deps.runner
    this.boundaries = deps.boundaries
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.memberBudgetMs = deps.memberBudgetMs ?? DEFAULT_MEMBER_BUDGET_MS
    this.memberConcurrency =
      deps.memberConcurrency ?? DEFAULT_MEMBER_CONCURRENCY
    this.log = deps.log ?? noop
    this.onTickSkipped = deps.onTickSkipped ?? noop
    this.onMemberBudgetExceeded = deps.onMemberBudgetExceeded ?? noop
    this.onError = deps.onError ?? noop
    this.random = deps.random ?? Math.random
  }

  /** Arms the recurring tick. Idempotent: a second call while running is a no-op. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext()
  }

  /** Stops future ticks and drains all work that can still access the store. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const inFlight = this.inFlight
    if (inFlight) await inFlight
    while (this.activeRunnerCalls.size > 0) {
      await Promise.allSettled(this.activeRunnerCalls)
    }
  }

  /** Ask the active pass and its member syncs to stop at their next checkpoint. */
  abortActivePass(): void {
    this.activePassController?.abort()
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => this.onTick(), this.jitteredDelay())
    this.timer.unref?.()
  }

  private jitteredDelay(): number {
    const jitter = this.intervalMs * JITTER_FRACTION * (this.random() * 2 - 1)
    return Math.max(0, Math.round(this.intervalMs + jitter))
  }

  private onTick(): void {
    this.timer = null
    if (this.stopped) return
    // Schedule the next tick before checking for overlap: the tick cadence
    // stays independent of how long any one pass takes.
    this.scheduleNext()
    if (this.inFlight) {
      this.onTickSkipped()
      return
    }
    this.inFlight = this.runPass()
      .catch((err: unknown) => this.onError(err))
      .finally(() => {
        this.inFlight = null
      })
  }

  private async runPass(): Promise<void> {
    const controller = new AbortController()
    this.activePassController = controller
    await this.runPassWithSignal(controller.signal)
  }

  private async runPassWithSignal(signal: AbortSignal): Promise<void> {
    const outcomes = await this.membership.runPass(this.boundaries)
    if (signal.aborted) return
    this.runner.completeMembershipPass(
      outcomes
        .filter((outcome) => outcome.ok)
        .map((outcome) => outcome.boundary),
    )
    const targets = outcomes.flatMap((outcome) => outcome.polls)

    let succeeded = 0
    let failed = 0
    let abandoned = 0
    let halted = 0
    let nextTarget = 0
    const workers = Array.from(
      { length: Math.min(this.memberConcurrency, targets.length) },
      async () => {
        while (nextTarget < targets.length) {
          if (signal.aborted) return
          const target = targets[nextTarget]!
          nextTarget += 1
          const outcome = await this.pollWithBudget(target, signal)
          if (outcome.status === 'abandoned') {
            abandoned += 1
            this.onMemberBudgetExceeded(target)
          } else if (outcome.status === 'errored') {
            failed += 1
          } else if (!outcome.result.ok) {
            if (outcome.result.reason === 'halted') {
              halted += 1
            } else {
              failed += 1
            }
          } else {
            succeeded += 1
          }
        }
      },
    )
    await Promise.all(workers)

    this.log({ targets: targets.length, succeeded, failed, abandoned, halted })
  }

  /**
   * Races one member's sync against `memberBudgetMs`. On timeout the promise
   * below resolves `'abandoned'` and aborts `runTarget`'s signal so the
   * underlying sync stops at its next checkpoint — its settlement is still
   * left unobserved by the pass that abandoned it, but it is no longer left
   * running unbounded.
   */
  private pollWithBudget(
    target: PollTarget,
    passSignal: AbortSignal,
  ): Promise<MemberPollOutcome> {
    return new Promise<MemberPollOutcome>((resolve) => {
      let settled = false
      const controller = new AbortController()
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        controller.abort()
        resolve({ status: 'abandoned' })
      }, this.memberBudgetMs)
      timer.unref?.()
      this.runTrackedTarget(
        target,
        AbortSignal.any([controller.signal, passSignal]),
      )
        .then((result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ status: 'completed', result })
        })
        .catch((err: unknown) => {
          // `runTarget` documents "never throws" — this is a backstop so a
          // violation can't surface as an unhandled rejection. Once this
          // member is already abandoned, a late rejection is most likely its
          // own abort taking effect, not a new failure, so it is dropped
          // rather than reported.
          if (settled) return
          this.onError(err)
          settled = true
          clearTimeout(timer)
          resolve({ status: 'errored' })
        })
    })
  }

  private runTrackedTarget(
    target: PollTarget,
    signal: AbortSignal,
  ): Promise<SpaceSyncRunResult> {
    const call = Promise.resolve().then(() =>
      this.runner.runTarget(target, signal),
    )
    this.activeRunnerCalls.add(call)
    void call.then(
      () => this.activeRunnerCalls.delete(call),
      () => this.activeRunnerCalls.delete(call),
    )
    return call
  }
}

function noop(): void {}
