import { boundaryToSpaceUri } from '@northskysocial/stratos-core'
import type { FeedgenStore } from '../db/index.js'
import {
  type DidMutationScope,
  SpaceMutationFence,
  type SpaceAuthorizationTarget,
} from '../mutation-fence.js'
import { STRATOS_FEED_SPACE_TYPE } from '../space-credential/index.js'

/**
 * The subset of `EnrollmentManager` the purger needs: dropping a viewer's
 * cached boundary set so a scope change is not masked by a stale cache entry.
 */
export interface BoundaryCacheInvalidator {
  invalidate: (did: string) => void
}

/**
 * The subset of `ActorPool` the purger needs: tearing down the live per-actor
 * WebSocket syncer so no further out-of-scope records are ingested after a
 * purge. Optional — reconciliation/purges that run without a live pool (tests,
 * `FEEDGEN_SUBSCRIBE_ENROLLMENTS=false`) simply skip this.
 */
export interface ActorRemover {
  removeActor: (did: string) => void
  removeActorAndDrain?: (did: string) => Promise<void>
}

/** Structured audit-log record emitted for every purge action. */
export interface PurgeAudit {
  trigger:
    | 'unenroll'
    | 'boundary-shrink'
    | 'boundary-deleted'
    | 'reconcile-unenroll'
    | 'reconcile-boundary-shrink'
    | 'space-unenroll'
    | 'space-boundary-shrink'
    | 'space-commit-invalid'
  did?: string
  boundary?: string
  counts: PurgeCounts
}

/** Per-store row counts removed by a single purge action. */
export interface PurgeCounts {
  /** `post` rows fully deleted (their `post_boundary` rows cascade). */
  posts: number
  /** `sync_cursor` rows removed. */
  cursors: number
  /** `space_sync_cursor` rows removed. */
  spaceCursors: number
  /** `enrolled_actor` rows removed. */
  enrolledActors: number
  /** in-memory boundary-cache entries invalidated. */
  boundaryCache: number
}

export interface GuardedBoundaryPurgeResult {
  committed: boolean
  counts: PurgeCounts
}

export interface PurgerDeps {
  store: FeedgenStore
  /** Shared with membership and the space syncer in production. */
  mutationFence?: SpaceMutationFence
  /** In-memory viewer→boundaries cache (`EnrollmentManager`). Optional. */
  enrollmentCache?: BoundaryCacheInvalidator
  /** Live per-actor syncer pool (`ActorPool`). Optional. */
  actorPool?: ActorRemover
  /** Structured audit-log sink. Defaults to `console.log(JSON.stringify(...))`. */
  audit?: (entry: PurgeAudit) => void
}

function zeroCounts(): PurgeCounts {
  return {
    posts: 0,
    cursors: 0,
    spaceCursors: 0,
    enrolledActors: 0,
    boundaryCache: 0,
  }
}

/**
 * Feedgen deletion pathway.
 *
 * Purges the synced records **and** the derived state the feedgen holds for
 * content that has left scope: `post` rows (and their cascaded `post_boundary`
 * index rows and inlined blob refs), `sync_cursor` state, the `enrolled_actor`
 * snapshot, the live `ActorPool` syncer, and the in-memory `EnrollmentManager`
 * boundary cache.
 *
 * IMPORTANT: this is **best-effort syncer hygiene, NOT a GDPR /
 * right-to-be-forgotten guarantee** (design R-2 residual). It removes the
 * feedgen's local copies on a best-effort basis; it makes no claim about
 * downstream-of-feedgen caches, backups, in-flight requests, or records already
 * served. Every operation is idempotent — re-running a purge for an already
 * clean subject is a no-op that removes nothing and never errors.
 */
export class Purger {
  private readonly store: FeedgenStore
  private readonly mutationFence: SpaceMutationFence
  private readonly enrollmentCache?: BoundaryCacheInvalidator
  private readonly actorPool?: ActorRemover
  private readonly audit: (entry: PurgeAudit) => void

  constructor(deps: PurgerDeps) {
    this.store = deps.store
    this.mutationFence = deps.mutationFence ?? new SpaceMutationFence()
    this.enrollmentCache = deps.enrollmentCache
    this.actorPool = deps.actorPool
    this.audit = deps.audit ?? defaultAudit
  }

  async withDidScope<T>(
    did: string,
    operation: (scope: DidMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.mutationFence.withDidScope(did, operation)
  }

  /**
   * Actor left Stratos entirely: purge ALL of the actor's synced records,
   * every derived entry (index rows cascade with the posts), blob refs
   * (inlined in the post row), cursor state (both the Stratos subscription
   * cursor and any cross-host space-sync cursors), the enrolled-actor
   * snapshot, the boundary-cache entry, and tear down the live syncer.
   */
  async purgeActor(did: string): Promise<PurgeCounts> {
    return this.purgeWholeActor(did, 'unenroll')
  }

  async purgeReconciledActor(did: string): Promise<PurgeCounts> {
    return this.purgeWholeActor(did, 'reconcile-unenroll')
  }

  async purgeSpaceActor(did: string): Promise<PurgeCounts> {
    return this.purgeWholeActor(did, 'space-unenroll')
  }

  private async purgeWholeActor(
    did: string,
    trigger: 'unenroll' | 'reconcile-unenroll' | 'space-unenroll',
  ): Promise<PurgeCounts> {
    return this.mutationFence.withDidScope(did, (scope) =>
      this.purgeWholeActorWithinScope(scope, trigger),
    )
  }

  async purgeReconciledActorWithinScope(
    scope: DidMutationScope,
  ): Promise<PurgeCounts> {
    return this.purgeWholeActorWithinScope(scope, 'reconcile-unenroll')
  }

  async purgeReconciledActorAfterDrainWithinScope(
    scope: DidMutationScope,
  ): Promise<PurgeCounts> {
    return this.mutationFence.revokeActorWithinScope(scope, () =>
      this.deleteWholeActorState(scope.did, 'reconcile-unenroll'),
    )
  }

  private async purgeWholeActorWithinScope(
    scope: DidMutationScope,
    trigger: 'unenroll' | 'reconcile-unenroll' | 'space-unenroll',
  ): Promise<PurgeCounts> {
    return this.mutationFence.revokeActorWithinScope(scope, async () => {
      const counts = zeroCounts()
      counts.boundaryCache = this.invalidate(scope.did)
      // Stop ingestion first so no new records race the delete.
      if (this.actorPool?.removeActorAndDrain) {
        await this.actorPool.removeActorAndDrain(scope.did)
      } else {
        this.actorPool?.removeActor(scope.did)
      }
      return this.deleteWholeActorState(scope.did, trigger, counts)
    })
  }

  private async deleteWholeActorState(
    did: string,
    trigger: 'unenroll' | 'reconcile-unenroll' | 'space-unenroll',
    counts = zeroCounts(),
  ): Promise<PurgeCounts> {
    counts.boundaryCache ||= this.invalidate(did)
    await this.store.deleteSpaceSyncStages(did)
    counts.cursors = await this.store.deleteCursor(did)
    counts.spaceCursors = await this.store.deleteSpaceCursors(did)
    counts.posts = await this.store.deletePostsByDid(did)
    counts.enrolledActors = await this.deleteEnrolledActor(did)
    this.audit({ trigger, did, counts })
    return counts
  }

  /**
   * Actor's boundary set shrank (they left `boundary`). Purge only the derived
   * entries for `boundary` and any of the actor's posts that are left with no
   * remaining in-scope boundary. The enrolled-actor snapshot is NOT removed
   * (the actor is still enrolled) — the caller updates it separately. The
   * boundary cache is invalidated so viewer resolution reflects the change.
   *
   */
  async purgeActorBoundary(
    did: string,
    boundary: string,
  ): Promise<PurgeCounts> {
    return this.mutationFence.withDidScope(did, (scope) =>
      this.purgeActorBoundaryWithinScope(scope, boundary),
    )
  }

  async purgeActorBoundaryWithinScope(
    scope: DidMutationScope,
    boundary: string,
  ): Promise<PurgeCounts> {
    return this.purgeBoundaryWithinScope(scope, boundary, 'boundary-shrink')
  }

  async purgeReconciledActorBoundary(
    did: string,
    boundary: string,
  ): Promise<PurgeCounts> {
    return this.mutationFence.withDidScope(did, (scope) =>
      this.purgeReconciledActorBoundaryWithinScope(scope, boundary),
    )
  }

  async purgeReconciledActorBoundaryWithinScope(
    scope: DidMutationScope,
    boundary: string,
  ): Promise<PurgeCounts> {
    return this.purgeBoundaryWithinScope(
      scope,
      boundary,
      'reconcile-boundary-shrink',
    )
  }

  /**
   * Reconcile-only boundary purge whose store transaction commits only while
   * the caller's fresh snapshot still wins over queued live enrollment work.
   */
  async purgeReconciledActorBoundaryGuardedWithinScope(
    scope: DidMutationScope,
    boundary: string,
    shouldCommit: () => boolean,
  ): Promise<GuardedBoundaryPurgeResult> {
    const spaceUri = spaceUriForBoundary(boundary)
    return this.mutationFence.revokeSpaceWithinScope(
      scope,
      boundary,
      spaceUri,
      async () => {
        const counts = zeroCounts()
        const boundaryCache = this.invalidate(scope.did)
        const deleted = await this.store.deleteActorBoundaryStateGuarded(
          spaceUri,
          scope.did,
          boundary,
          shouldCommit,
        )
        if (!deleted.committed) return { committed: false, counts }

        counts.boundaryCache = boundaryCache
        counts.posts = deleted.posts
        counts.spaceCursors = deleted.spaceCursors
        this.audit({
          trigger: 'reconcile-boundary-shrink',
          did: scope.did,
          boundary,
          counts,
        })
        return { committed: true, counts }
      },
    )
  }

  private async purgeBoundaryWithinScope(
    scope: DidMutationScope,
    boundary: string,
    trigger: 'boundary-shrink' | 'reconcile-boundary-shrink',
  ): Promise<PurgeCounts> {
    const spaceUri = spaceUriForBoundary(boundary)
    return this.mutationFence.revokeSpaceWithinScope(
      scope,
      boundary,
      spaceUri,
      () =>
        this.purgeActorBoundaryState(scope.did, boundary, trigger, spaceUri),
    )
  }

  async purgeSpaceDeparture(
    did: string,
    boundary: string,
    spaceUri: string,
  ): Promise<PurgeCounts> {
    return this.mutationFence.revokeSpace(did, boundary, spaceUri, () =>
      this.purgeActorBoundaryState(
        did,
        boundary,
        'space-boundary-shrink',
        spaceUri,
      ),
    )
  }

  async purgeInvalidSpaceCommit(
    target: SpaceAuthorizationTarget,
  ): Promise<PurgeCounts> {
    return this.mutationFence.revokeSpaceForRun(target, () =>
      this.purgeActorBoundaryState(
        target.did,
        target.boundary,
        'space-commit-invalid',
        target.spaceUri,
      ),
    )
  }

  private async purgeActorBoundaryState(
    did: string,
    boundary: string,
    trigger:
      | 'boundary-shrink'
      | 'reconcile-boundary-shrink'
      | 'space-boundary-shrink'
      | 'space-commit-invalid',
    spaceUri?: string,
  ): Promise<PurgeCounts> {
    const counts = zeroCounts()
    counts.boundaryCache = this.invalidate(did)
    if (spaceUri) {
      await this.store.deleteSpaceSyncStage(spaceUri, did)
      counts.spaceCursors = await this.store.deleteSpaceCursor(spaceUri, did)
    }
    counts.posts = await this.store.deletePostsByDidBoundary(did, boundary)
    this.audit({ trigger, did, boundary, counts })
    return counts
  }

  /**
   * A boundary/space was deleted service-wide: purge every record, derived
   * entry, blob ref, and deterministic cursor for that space across ALL
   * actors. Subscription cursors and enrolled-actor snapshots remain intact —
   * an actor may still hold other in-scope boundaries.
   */
  async purgeBoundary(boundary: string): Promise<PurgeCounts> {
    const spaceUri = spaceUriForBoundary(boundary)
    return this.mutationFence.revokeBoundaryForAll(boundary, async () => {
      const counts = zeroCounts()
      await this.store.deleteSpaceSyncStagesBySpace(spaceUri)
      counts.spaceCursors = await this.store.deleteSpaceCursorsBySpace(spaceUri)
      counts.posts = await this.store.deletePostsByBoundary(boundary)
      this.audit({ trigger: 'boundary-deleted', boundary, counts })
      return counts
    })
  }

  private async deleteEnrolledActor(did: string): Promise<number> {
    const existing = await this.store.getEnrolledActor(did)
    if (!existing) return 0
    await this.store.deleteEnrolledActor(did)
    return 1
  }

  private invalidate(did: string): number {
    if (!this.enrollmentCache) return 0
    this.enrollmentCache.invalidate(did)
    return 1
  }
}

function spaceUriForBoundary(boundary: string): string {
  const result = boundaryToSpaceUri(boundary, STRATOS_FEED_SPACE_TYPE)
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function defaultAudit(entry: PurgeAudit): void {
  console.log(JSON.stringify({ msg: 'feedgen.purge', ...entry }))
}
