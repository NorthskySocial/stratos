import type { FeedgenStore } from '../db/index.js'

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
  /** `enrolled_actor` rows removed. */
  enrolledActors: number
  /** in-memory boundary-cache entries invalidated. */
  boundaryCache: number
}

export interface PurgerDeps {
  store: FeedgenStore
  /** In-memory viewer→boundaries cache (`EnrollmentManager`). Optional. */
  enrollmentCache?: BoundaryCacheInvalidator
  /** Live per-actor syncer pool (`ActorPool`). Optional. */
  actorPool?: ActorRemover
  /** Structured audit-log sink. Defaults to `console.log(JSON.stringify(...))`. */
  audit?: (entry: PurgeAudit) => void
}

function zeroCounts(): PurgeCounts {
  return { posts: 0, cursors: 0, enrolledActors: 0, boundaryCache: 0 }
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
  private readonly enrollmentCache?: BoundaryCacheInvalidator
  private readonly actorPool?: ActorRemover
  private readonly audit: (entry: PurgeAudit) => void

  constructor(deps: PurgerDeps) {
    this.store = deps.store
    this.enrollmentCache = deps.enrollmentCache
    this.actorPool = deps.actorPool
    this.audit = deps.audit ?? defaultAudit
  }

  /**
   * Actor left Stratos entirely: purge ALL of the actor's synced records,
   * every derived entry (index rows cascade with the posts), blob refs
   * (inlined in the post row), cursor state, the enrolled-actor snapshot, the
   * boundary-cache entry, and tear down the live syncer.
   */
  async purgeActor(
    did: string,
    trigger: 'unenroll' | 'reconcile-unenroll' | 'space-unenroll' = 'unenroll',
  ): Promise<PurgeCounts> {
    // Stop ingestion first so no new records race the delete.
    this.actorPool?.removeActor(did)
    const counts = zeroCounts()
    counts.posts = await this.store.deletePostsByDid(did)
    counts.cursors = await this.store.deleteCursor(did)
    counts.enrolledActors = await this.deleteEnrolledActor(did)
    counts.boundaryCache = this.invalidate(did)
    this.audit({ trigger, did, counts })
    return counts
  }

  /**
   * Actor's boundary set shrank (they left `boundary`). Purge only the derived
   * entries for `boundary` and any of the actor's posts that are left with no
   * remaining in-scope boundary. The enrolled-actor snapshot is NOT removed
   * (the actor is still enrolled) — the caller updates it separately. The
   * boundary cache is invalidated so viewer resolution reflects the change.
   */
  async purgeActorBoundary(
    did: string,
    boundary: string,
    trigger:
      | 'boundary-shrink'
      | 'reconcile-boundary-shrink'
      | 'space-boundary-shrink' = 'boundary-shrink',
  ): Promise<PurgeCounts> {
    const counts = zeroCounts()
    counts.posts = await this.store.deletePostsByDidBoundary(did, boundary)
    counts.boundaryCache = this.invalidate(did)
    this.audit({ trigger, did, boundary, counts })
    return counts
  }

  /**
   * A boundary/space was deleted service-wide: purge every record, derived
   * entry, and blob ref scoped to `boundary` across ALL actors. Cursors and
   * enrolled-actor snapshots are per-actor (not per-boundary) so they are left
   * intact — an actor may still hold other in-scope boundaries.
   */
  async purgeBoundary(boundary: string): Promise<PurgeCounts> {
    const counts = zeroCounts()
    counts.posts = await this.store.deletePostsByBoundary(boundary)
    this.audit({ trigger: 'boundary-deleted', boundary, counts })
    return counts
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

function defaultAudit(entry: PurgeAudit): void {
  console.log(JSON.stringify({ msg: 'feedgen.purge', ...entry }))
}
