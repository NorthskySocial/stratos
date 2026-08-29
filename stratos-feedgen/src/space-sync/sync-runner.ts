import type { FeedgenStore } from '../db/index.js'
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

export interface SpaceSyncRunnerDeps {
  syncer: Pick<SpaceSyncer, 'syncTarget'>
  verifier: Pick<CommitVerifier, 'verify'>
  store: Pick<FeedgenStore, 'deleteSpaceCursor'>
  purger: Pick<Purger, 'purgeActorBoundary'>
  /** Called once per non-transient verification failure. Defaults to `console.error`. */
  onVerifyFailure?: (event: SpaceCommitVerifyLogEvent) => void
  /** Called once per transient (DID-resolution) verification failure. Defaults to `console.warn`. */
  onVerifyTransient?: (event: SpaceCommitVerifyLogEvent, error: unknown) => void
  /** Called when the same poll target fails verification on two or more consecutive passes. Defaults to `console.warn`. */
  onConsecutiveFailure?: (event: SpaceCommitConsecutiveFailureLogEvent) => void
  /** Called if settling a verification failure (purge, cursor drop) itself throws. Defaults to `console.error`. */
  onError?: (target: PollTarget, err: unknown) => void
}

/**
 * Composes the WP4 space poller with WP5 commit verification.
 *
 * `runTarget` is the unit WP6's scheduler calls once per poll target per
 * tick. There is no retry loop here: a failed target is simply not polled
 * again until the next membership pass produces a fresh poll target for it.
 * That next pass is what "halt until next membership pass" means in
 * practice — WP6's scheduler re-derives membership every tick, so no
 * cross-tick "halted" state needs to live in this class.
 *
 * The consecutive-failure streak is the one piece of state that DOES persist
 * across calls, and it is deliberately in-process only: correct-from-empty
 * on restart is an acceptable cold start for a warning signal.
 */
export class SpaceSyncRunner {
  private readonly syncer: SpaceSyncRunnerDeps['syncer']
  private readonly verifier: SpaceSyncRunnerDeps['verifier']
  private readonly store: SpaceSyncRunnerDeps['store']
  private readonly purger: SpaceSyncRunnerDeps['purger']
  private readonly onVerifyFailure: (event: SpaceCommitVerifyLogEvent) => void
  private readonly onVerifyTransient: (
    event: SpaceCommitVerifyLogEvent,
    error: unknown,
  ) => void
  private readonly onConsecutiveFailure: (
    event: SpaceCommitConsecutiveFailureLogEvent,
  ) => void
  private readonly onError: (target: PollTarget, err: unknown) => void
  /** Consecutive non-transient verification failures, keyed by space then member. */
  private readonly failureStreaks = new Map<string, Map<string, number>>()

  constructor(deps: SpaceSyncRunnerDeps) {
    this.syncer = deps.syncer
    this.verifier = deps.verifier
    this.store = deps.store
    this.purger = deps.purger
    this.onVerifyFailure = deps.onVerifyFailure ?? defaultOnVerifyFailure
    this.onVerifyTransient = deps.onVerifyTransient ?? defaultOnVerifyTransient
    this.onConsecutiveFailure =
      deps.onConsecutiveFailure ?? defaultOnConsecutiveFailure
    this.onError = deps.onError ?? defaultOnError
  }

  /**
   * Never throws — a failure to settle a bad commit (purge/cursor-drop) is
   * reported and swallowed rather than left to break a caller iterating a
   * target list, matching `SpaceSyncer.syncTarget`'s own contract.
   */
  async runTarget(target: PollTarget): Promise<SpaceSyncRunResult> {
    const result = await this.syncer.syncTarget(target)
    if (!result.ok) return result
    // Only the host's own terminal page carries a commit. A pass cut short
    // by our own page/record caps never reached one, and that is normal
    // traffic, not a verification failure.
    if (result.stopReason !== 'complete') return result

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

    try {
      return await this.settleVerifyFailure(target, verifyResult.reason)
    } catch (err) {
      this.onError(target, err)
      return { target, ok: false, reason: 'member-skip', error: err }
    }
  }

  private async settleVerifyFailure(
    target: PollTarget,
    reason: CommitVerifyFailureReason,
  ): Promise<SpaceSyncRunFailure> {
    await this.purger.purgeActorBoundary(
      target.did,
      target.boundary,
      'space-commit-invalid',
    )
    await this.store.deleteSpaceCursor(target.spaceUri, target.did)
    this.onVerifyFailure({ target, reason })

    const streak = this.bumpStreak(target)
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

  private bumpStreak(target: PollTarget): number {
    const byMember =
      this.failureStreaks.get(target.spaceUri) ?? new Map<string, number>()
    const streak = (byMember.get(target.did) ?? 0) + 1
    byMember.set(target.did, streak)
    this.failureStreaks.set(target.spaceUri, byMember)
    return streak
  }

  private resetStreak(target: PollTarget): void {
    this.failureStreaks.get(target.spaceUri)?.delete(target.did)
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
