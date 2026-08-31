import type { Purger } from '../purge/index.js'
import {
  CommitVerifier,
  type CommitVerifyFailureReason,
} from './commit-verify.js'
import type { PollTarget } from './membership.js'
import type {
  SpaceSyncer,
  SpaceSyncFailure,
  SpaceSyncSuccess,
} from './space-syncer.js'

export type SpaceSyncRunFailureReason =
  | SpaceSyncFailure['reason']
  | 'commit-verify-failed'
  | 'commit-verify-transient'
  | 'halted'

export interface SpaceSyncRunFailure {
  readonly target: PollTarget
  readonly ok: false
  readonly reason: SpaceSyncRunFailureReason
  /** Set only when `reason` is one of the `commit-verify-*` values. */
  readonly commitVerifyReason?: CommitVerifyFailureReason
  readonly error?: unknown
}

export type SpaceSyncRunResult = SpaceSyncSuccess | SpaceSyncRunFailure

export interface SpaceCommitVerifyLogEvent {
  target: PollTarget
  reason: CommitVerifyFailureReason
}

export interface SpaceCommitConsecutiveFailureLogEvent {
  target: PollTarget
  streak: number
}

export interface SpaceCapStopStreakLogEvent {
  target: PollTarget
  streak: number
}

const DEFAULT_HALT_COOLDOWN_BASE_MS = 5 * 60_000
const DEFAULT_HALT_COOLDOWN_CAP_MS = 60 * 60_000
/**
 * Consecutive per-member-cap stops — a sync that never reached a terminal
 * page — before a member is halted without a purge. One cap stop is ordinary
 * traffic for an active member; this many in a row with no completed sync is
 * unusual enough to back off and let them catch up.
 */
const CAP_STOP_HALT_THRESHOLD = 3

export interface SpaceSyncRunnerDeps {
  syncer: Pick<SpaceSyncer, 'syncTarget'>
  verifier: Pick<CommitVerifier, 'verify'>
  purger: Pick<Purger, 'purgeActorBoundary'>
  /** Called once per non-transient verification failure. Defaults to `console.error`. */
  onVerifyFailure?: (event: SpaceCommitVerifyLogEvent) => void
  /** Called once per transient (DID-resolution) verification failure. Defaults to `console.warn`. */
  onVerifyTransient?: (event: SpaceCommitVerifyLogEvent, error: unknown) => void
  /** Called when the same poll target fails verification on two or more consecutive passes. Defaults to `console.warn`. */
  onConsecutiveFailure?: (event: SpaceCommitConsecutiveFailureLogEvent) => void
  /** Called once per per-member-cap stop, streak included. Defaults to `console.warn`. */
  onCapStopStreak?: (event: SpaceCapStopStreakLogEvent) => void
  /** Called if settling a verification failure (purge, cursor drop) itself throws. Defaults to `console.error`. */
  onError?: (target: PollTarget, err: unknown) => void
  /** Base halt cooldown, doubling per consecutive cause, capped at `haltCooldownCapMs`. Default 5 minutes. */
  haltCooldownBaseMs?: number
  /** Upper bound on the halt cooldown. Default 1 hour. */
  haltCooldownCapMs?: number
  /** Injectable clock (epoch ms) for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Composes the WP4 space poller with WP5 commit verification.
 *
 * `runTarget` is the unit WP6's scheduler calls once per poll target per
 * tick. There is no retry loop here: an invalid commit halts its target for
 * the current membership pass, and a completed membership refresh permits
 * one fresh attempt.
 *
 * Failure streaks and halt cooldowns are the state that persists across
 * calls, and both are deliberately in-process only: MM-11 relies on
 * restart-equals-retry, so losing them on restart is an accepted cold start
 * (one extra poll attempt, never a missed one), not a gap to fix here.
 */
export class SpaceSyncRunner {
  private readonly syncer: SpaceSyncRunnerDeps['syncer']
  private readonly verifier: SpaceSyncRunnerDeps['verifier']
  private readonly purger: SpaceSyncRunnerDeps['purger']
  private readonly onVerifyFailure: (event: SpaceCommitVerifyLogEvent) => void
  private readonly onVerifyTransient: (
    event: SpaceCommitVerifyLogEvent,
    error: unknown,
  ) => void
  private readonly onConsecutiveFailure: (
    event: SpaceCommitConsecutiveFailureLogEvent,
  ) => void
  private readonly onCapStopStreak: (event: SpaceCapStopStreakLogEvent) => void
  private readonly onError: (target: PollTarget, err: unknown) => void
  private readonly haltCooldownBaseMs: number
  private readonly haltCooldownCapMs: number
  private readonly now: () => number
  /** Consecutive non-transient verification failures, keyed by space then member. */
  private readonly failureStreaks = new Map<string, Map<string, number>>()
  /** Consecutive per-member-cap stops, keyed by space then member. */
  private readonly capStopStreaks = new Map<string, Map<string, number>>()
  /** Epoch ms before which a target is skipped with no network call, keyed by space then member. */
  private readonly nextEligibleAt = new Map<string, Map<string, number>>()
  /** Membership generation in which an invalid commit halted each target. */
  private readonly invalidCommitPasses = new Map<string, Map<string, number>>()
  /** Last completed membership generation, keyed by boundary. */
  private readonly membershipPasses = new Map<string, number>()

  constructor(deps: SpaceSyncRunnerDeps) {
    this.syncer = deps.syncer
    this.verifier = deps.verifier
    this.purger = deps.purger
    this.onVerifyFailure = deps.onVerifyFailure ?? defaultOnVerifyFailure
    this.onVerifyTransient = deps.onVerifyTransient ?? defaultOnVerifyTransient
    this.onConsecutiveFailure =
      deps.onConsecutiveFailure ?? defaultOnConsecutiveFailure
    this.onCapStopStreak = deps.onCapStopStreak ?? defaultOnCapStopStreak
    this.onError = deps.onError ?? defaultOnError
    this.haltCooldownBaseMs =
      deps.haltCooldownBaseMs ?? DEFAULT_HALT_COOLDOWN_BASE_MS
    this.haltCooldownCapMs =
      deps.haltCooldownCapMs ?? DEFAULT_HALT_COOLDOWN_CAP_MS
    this.now = deps.now ?? Date.now
  }

  /** Permit invalid-commit retries only for boundaries refreshed successfully. */
  completeMembershipPass(boundaries: Iterable<string>): void {
    for (const boundary of boundaries) {
      const generation = this.membershipPasses.get(boundary) ?? 0
      this.membershipPasses.set(boundary, generation + 1)
    }
  }

  /**
   * Never throws — a failure to settle a bad commit (purge/cursor-drop) is
   * reported and swallowed rather than left to break a caller iterating a
   * target list, matching `SpaceSyncer.syncTarget`'s own contract.
   *
   * `signal`, when provided, is forwarded to the underlying sync so a caller
   * (the scheduler's per-member time budget) can cut a slow member short.
   */
  async runTarget(
    target: PollTarget,
    signal?: AbortSignal,
  ): Promise<SpaceSyncRunResult> {
    if (this.isHalted(target)) {
      return { target, ok: false, reason: 'halted' }
    }
    const membershipPass = this.membershipPasses.get(target.boundary) ?? 0

    const result = await this.syncer.syncTarget(target, signal)
    if (!result.ok) return result

    if (result.stopReason === 'per-member-cap') {
      return this.handleCapStop(target, result)
    }
    this.resetCapStopStreak(target)
    // Only the host's own terminal page carries a commit. A pass cut short
    // by our own page cap never reached one, and that is normal traffic, not
    // a verification failure.
    if (result.stopReason !== 'complete') return result

    try {
      const verifyResult = await this.verifier.verify(
        target.spaceUri,
        target.did,
        result.finalCommit,
      )
      if (verifyResult.ok) {
        this.resetStreak(target)
        return result
      }

      if (verifyResult.transient) {
        this.onVerifyTransient(
          { target, reason: verifyResult.reason },
          verifyResult.error,
        )
        return result
      }

      return await this.settleVerifyFailure(
        target,
        verifyResult.reason,
        membershipPass,
      )
    } catch (err) {
      this.onError(target, err)
      return { target, ok: false, reason: 'member-skip', error: err }
    }
  }

  /**
   * A member stuck at the per-member cap for several consecutive passes is
   * indistinguishable from an ordinary busy member: a cap stop never reaches
   * a terminal page, so `finalCommit` is never populated and verification
   * cannot run. Treating the streak as a verification failure would purge a
   * member for being active, not for tampering, so this halts polling
   * without touching their records or cursor.
   */
  private handleCapStop(
    target: PollTarget,
    result: SpaceSyncSuccess,
  ): SpaceSyncRunResult {
    const streak = this.bumpCapStopStreak(target)
    this.onCapStopStreak({ target, streak })
    if (streak >= CAP_STOP_HALT_THRESHOLD) {
      this.haltTarget(target, streak - CAP_STOP_HALT_THRESHOLD + 1)
    }
    return result
  }

  private async settleVerifyFailure(
    target: PollTarget,
    reason: CommitVerifyFailureReason,
    membershipPass: number,
  ): Promise<SpaceSyncRunFailure> {
    await this.purger.purgeActorBoundary(
      target.did,
      target.boundary,
      'space-commit-invalid',
      target.spaceUri,
    )
    this.onVerifyFailure({ target, reason })

    const streak = this.bumpStreak(target)
    this.haltInvalidCommit(target, membershipPass)
    if (streak >= 2) {
      this.onConsecutiveFailure({ target, streak })
    }

    return {
      target,
      ok: false,
      reason: 'commit-verify-failed',
      commitVerifyReason: reason,
    }
  }

  private isHalted(target: PollTarget): boolean {
    const invalidCommitPass = this.invalidCommitPasses
      .get(target.spaceUri)
      ?.get(target.did)
    const membershipPass = this.membershipPasses.get(target.boundary) ?? 0
    if (invalidCommitPass === membershipPass) return true
    const at = this.nextEligibleAt.get(target.spaceUri)?.get(target.did)
    return at !== undefined && this.now() < at
  }

  private haltInvalidCommit(target: PollTarget, membershipPass: number): void {
    const byMember =
      this.invalidCommitPasses.get(target.spaceUri) ?? new Map<string, number>()
    byMember.set(target.did, membershipPass)
    this.invalidCommitPasses.set(target.spaceUri, byMember)
  }

  private haltTarget(target: PollTarget, escalation: number): void {
    const cooldownMs = Math.min(
      this.haltCooldownBaseMs * 2 ** Math.max(0, escalation - 1),
      this.haltCooldownCapMs,
    )
    const byMember =
      this.nextEligibleAt.get(target.spaceUri) ?? new Map<string, number>()
    byMember.set(target.did, this.now() + cooldownMs)
    this.nextEligibleAt.set(target.spaceUri, byMember)
  }

  private bumpStreak(target: PollTarget): number {
    const byMember =
      this.failureStreaks.get(target.spaceUri) ?? new Map<string, number>()
    const streak = (byMember.get(target.did) ?? 0) + 1
    byMember.set(target.did, streak)
    this.failureStreaks.set(target.spaceUri, byMember)
    return streak
  }

  private bumpCapStopStreak(target: PollTarget): number {
    const byMember =
      this.capStopStreaks.get(target.spaceUri) ?? new Map<string, number>()
    const streak = (byMember.get(target.did) ?? 0) + 1
    byMember.set(target.did, streak)
    this.capStopStreaks.set(target.spaceUri, byMember)
    return streak
  }

  private resetCapStopStreak(target: PollTarget): void {
    this.capStopStreaks.get(target.spaceUri)?.delete(target.did)
  }

  /** A verified sync proves the member is neither tampering nor merely busy. */
  private resetStreak(target: PollTarget): void {
    this.failureStreaks.get(target.spaceUri)?.delete(target.did)
    this.invalidCommitPasses.get(target.spaceUri)?.delete(target.did)
    this.nextEligibleAt.get(target.spaceUri)?.delete(target.did)
    this.resetCapStopStreak(target)
  }
}

function defaultOnVerifyFailure(event: SpaceCommitVerifyLogEvent): void {
  console.error(
    `space commit verification failed for ${event.target.did} in ${event.target.spaceUri}: ${event.reason}`,
  )
}

function defaultOnVerifyTransient(
  event: SpaceCommitVerifyLogEvent,
  error: unknown,
): void {
  console.warn(
    `space commit verification could not resolve a key for ${event.target.did} in ${event.target.spaceUri}, skipping this pass:`,
    error,
  )
}

function defaultOnConsecutiveFailure(
  event: SpaceCommitConsecutiveFailureLogEvent,
): void {
  console.warn(
    `space commit verification has failed ${event.streak} consecutive passes for ${event.target.did} in ${event.target.spaceUri}`,
  )
}

function defaultOnCapStopStreak(event: SpaceCapStopStreakLogEvent): void {
  console.warn(
    `space sync hit the per-member cap ${event.streak} consecutive passes for ${event.target.did} in ${event.target.spaceUri}`,
  )
}

function defaultOnError(target: PollTarget, err: unknown): void {
  console.error(
    `failed to settle a space commit verification failure for ${target.did} in ${target.spaceUri}:`,
    err,
  )
}
