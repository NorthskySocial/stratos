import type { Purger } from '../purge/index.js'
import type { SpaceMutationFence } from '../mutation-fence.js'
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
  | 'halted'

export interface SpaceSyncRunFailure {
  readonly target: PollTarget
  readonly ok: false
  readonly reason: SpaceSyncRunFailureReason
  /** Set only when `reason` is `commit-verify-failed`. */
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

export interface SpaceSyncRunnerDeps {
  syncer: Pick<SpaceSyncer, 'syncTarget'>
  verifier: Pick<CommitVerifier, 'verify'>
  purger: Pick<Purger, 'purgeInvalidSpaceCommit'>
  mutationFence: Pick<SpaceMutationFence, 'issueRunLease'>
  /** Called once per non-transient verification failure. Defaults to `console.error`. */
  onVerifyFailure?: (event: SpaceCommitVerifyLogEvent) => void
  /** Called once per transient (DID-resolution) verification failure. Defaults to `console.warn`. */
  onVerifyTransient?: (event: SpaceCommitVerifyLogEvent, error: unknown) => void
  /** Called when the same poll target fails verification on two or more consecutive passes. Defaults to `console.warn`. */
  onConsecutiveFailure?: (event: SpaceCommitConsecutiveFailureLogEvent) => void
  /** Optional per-target cap-streak observer. Production reports caps per scheduler pass. */
  onCapStopStreak?: (event: SpaceCapStopStreakLogEvent) => void
  /** Called if settling a verification failure (purge, cursor drop) itself throws. Defaults to `console.error`. */
  onError?: (target: PollTarget, err: unknown) => void
}

/**
 * Composes the WP4 space poller with WP5 commit verification.
 *
 * `runTarget` is the unit WP6's scheduler calls once per poll target per
 * tick. There is no retry loop here: an invalid commit halts its target for
 * the current membership pass, and a completed membership refresh permits
 * one fresh attempt.
 *
 * Verification failure streaks and the invalid-commit membership-pass halt
 * are deliberately in-process only: MM-11 relies on restart-equals-retry, so
 * losing them on restart is an accepted cold start (one extra poll attempt,
 * never a missed one), not a gap to fix here.
 */
export class SpaceSyncRunner {
  private readonly syncer: SpaceSyncRunnerDeps['syncer']
  private readonly verifier: SpaceSyncRunnerDeps['verifier']
  private readonly purger: SpaceSyncRunnerDeps['purger']
  private readonly mutationFence: SpaceSyncRunnerDeps['mutationFence']
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
  /** Consecutive non-transient verification failures, keyed by space then member. */
  private readonly failureStreaks = new Map<string, Map<string, number>>()
  /** Consecutive per-member-cap stops, keyed by space then member. */
  private readonly capStopStreaks = new Map<string, Map<string, number>>()
  /** Membership generation in which an invalid commit halted each target. */
  private readonly invalidCommitPasses = new Map<string, Map<string, number>>()
  /** Last completed membership generation, keyed by boundary. */
  private readonly membershipPasses = new Map<string, number>()

  constructor(deps: SpaceSyncRunnerDeps) {
    this.syncer = deps.syncer
    this.verifier = deps.verifier
    this.purger = deps.purger
    this.mutationFence = deps.mutationFence
    this.onVerifyFailure = deps.onVerifyFailure ?? defaultOnVerifyFailure
    this.onVerifyTransient = deps.onVerifyTransient ?? defaultOnVerifyTransient
    this.onConsecutiveFailure =
      deps.onConsecutiveFailure ?? defaultOnConsecutiveFailure
    this.onCapStopStreak = deps.onCapStopStreak ?? noop
    this.onError = deps.onError ?? defaultOnError
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

    let runTarget: PollTarget
    try {
      runTarget = await this.mutationFence.issueRunLease(target)
    } catch (err) {
      this.onError(target, err)
      return { target, ok: false, reason: 'member-skip', error: err }
    }

    const result = await this.syncer.syncTarget(runTarget, signal)
    if (!result.ok) return result

    if (result.stopReason === 'per-member-cap') {
      return this.handleCapStop(runTarget, result)
    }
    this.resetCapStopStreak(runTarget)
    // Only the host's own terminal page carries a commit. A pass cut short
    // by our own page cap never reached one, and that is normal traffic, not
    // a verification failure.
    if (result.stopReason !== 'complete') return result

    try {
      const verifyResult = await this.verifier.verify(
        runTarget.spaceUri,
        runTarget.did,
        result.finalCommit,
      )
      if (verifyResult.ok) {
        this.resetStreak(runTarget)
        return result
      }

      if (verifyResult.transient) {
        this.onVerifyTransient(
          { target: runTarget, reason: verifyResult.reason },
          verifyResult.error,
        )
        return result
      }

      return await this.settleVerifyFailure(
        runTarget,
        verifyResult.reason,
        membershipPass,
      )
    } catch (err) {
      this.onError(runTarget, err)
      return { target: runTarget, ok: false, reason: 'member-skip', error: err }
    }
  }

  /**
   * A member stuck at the per-member cap for several consecutive passes is
   * indistinguishable from an ordinary busy member: a cap stop never reaches
   * a terminal page, so `finalCommit` is never populated and verification
   * cannot run. Treating the streak as a verification failure would purge a
   * member for being active, not for tampering. Report the streak, but keep
   * the target eligible so the next pass resumes from its stored cursor.
   */
  private handleCapStop(
    target: PollTarget,
    result: SpaceSyncSuccess,
  ): SpaceSyncRunResult {
    const streak = this.bumpCapStopStreak(target)
    this.onCapStopStreak({ target, streak })
    return result
  }

  private async settleVerifyFailure(
    target: PollTarget,
    reason: CommitVerifyFailureReason,
    membershipPass: number,
  ): Promise<SpaceSyncRunFailure> {
    await this.purger.purgeInvalidSpaceCommit(target)
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
    return invalidCommitPass === membershipPass
  }

  private haltInvalidCommit(target: PollTarget, membershipPass: number): void {
    const byMember =
      this.invalidCommitPasses.get(target.spaceUri) ?? new Map<string, number>()
    byMember.set(target.did, membershipPass)
    this.invalidCommitPasses.set(target.spaceUri, byMember)
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

function defaultOnError(target: PollTarget, err: unknown): void {
  console.error(
    `failed to settle a space commit verification failure for ${target.did} in ${target.spaceUri}:`,
    err,
  )
}

function noop(): void {}
