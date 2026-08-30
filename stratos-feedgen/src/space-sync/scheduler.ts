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

export interface SpaceSyncPassLogEvent {
  /** Poll targets produced by this pass's membership run. */
  targets: number
  /** Targets whose sync completed within budget and reported success. */
  succeeded: number
  /** Targets whose sync completed within budget but reported failure. */
  failed: number
  /** Targets abandoned for exceeding the member time budget this pass. */
  abandoned: number
}

export interface SpaceSyncSchedulerDeps {
  membership: Pick<MembershipTracker, 'runPass'>
  runner: Pick<SpaceSyncRunner, 'runTarget'>
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
 * - **A hung member cannot stall the pass.** `runTarget` has no
 *   cancellation seam — no `AbortSignal` reaches `listRepoOps`/`getRecord`
 *   in WP2-WP5 — so a member over `memberBudgetMs` is abandoned: the pass
 *   reports it via `onMemberBudgetExceeded` and moves on, leaving the
 *   underlying call to finish or fail on its own. This scheduler only ever
 *   holds `runner.runTarget`, never a store or cursor, so an abandoned
 *   member's cursor cannot be touched here even by accident — the next
 *   pass just retries it from wherever it last completed.
 *
 * `stop()` resolves once any in-flight pass has settled, which is the only
 * contract a caller needs: it composes with a plain sequential shutdown
 * today and with a future `ShutdownDeps` registry equally well.
 */
export class SpaceSyncScheduler {
  private readonly membership: SpaceSyncSchedulerDeps['membership']
  private readonly runner: SpaceSyncSchedulerDeps['runner']
  private readonly boundaries: Iterable<string>
  private readonly intervalMs: number
  private readonly memberBudgetMs: number
  private readonly log: (event: SpaceSyncPassLogEvent) => void
  private readonly onTickSkipped: () => void
  private readonly onMemberBudgetExceeded: (target: PollTarget) => void
  private readonly onError: (err: unknown) => void
  private readonly random: () => number

  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private stopped = true

  constructor(deps: SpaceSyncSchedulerDeps) {
    this.membership = deps.membership
    this.runner = deps.runner
    this.boundaries = deps.boundaries
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.memberBudgetMs = deps.memberBudgetMs ?? DEFAULT_MEMBER_BUDGET_MS
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

  /** Stops future ticks and resolves once any in-flight pass has settled. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.inFlight) {
      await this.inFlight
    }
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
    const outcomes = await this.membership.runPass(this.boundaries)
    const targets = outcomes.flatMap((outcome) => outcome.polls)

    let succeeded = 0
    let failed = 0
    let abandoned = 0
    await Promise.all(
      targets.map(async (target) => {
        const outcome = await this.pollWithBudget(target)
        if (outcome.status === 'abandoned') {
          abandoned += 1
          this.onMemberBudgetExceeded(target)
        } else if (outcome.status === 'errored' || !outcome.result.ok) {
          failed += 1
        } else {
          succeeded += 1
        }
      }),
    )

    this.log({ targets: targets.length, succeeded, failed, abandoned })
  }

  /**
   * Races one member's sync against `memberBudgetMs`. There is no
   * cancellation: on timeout the promise below resolves `'abandoned'` and
   * `runTarget`'s own promise is left to settle on its own, unobserved by
   * the pass that abandoned it.
   */
  private pollWithBudget(target: PollTarget): Promise<MemberPollOutcome> {
    return new Promise<MemberPollOutcome>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ status: 'abandoned' })
      }, this.memberBudgetMs)
      timer.unref?.()
      this.runner
        .runTarget(target)
        .then((result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ status: 'completed', result })
        })
        .catch((err: unknown) => {
          // `runTarget` documents "never throws" — this is a backstop so a
          // violation can't surface as an unhandled rejection after this
          // member has already been raced against its budget.
          this.onError(err)
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve({ status: 'errored' })
          }
        })
    })
  }
}

function noop(): void {}
