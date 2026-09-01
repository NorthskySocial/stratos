import type { EnrolledActor, FeedgenStore } from '../db/index.js'
import type {
  DidMutationScope,
  SpaceMutationFence,
} from '../space-sync/index.js'
import type { ActorPool } from '../subscription/index.js'
import type { ResolveEnrollmentsResult } from '../upstream/index.js'
import type { PurgeCounts, Purger } from './purger.js'

export interface ReconcileEnrollmentsClient {
  resolveEnrollments: (did: string) => Promise<ResolveEnrollmentsResult>
}

export interface ReconcileDeps {
  store: FeedgenStore
  purger: Purger
  mutationFence?: Pick<SpaceMutationFence, 'hasPendingDidMutation'>
  actorPool?: Pick<ActorPool, 'addActor' | 'removeActorAndDrain'>
  client: ReconcileEnrollmentsClient
  /** Structured summary sink. Defaults to `console.log(JSON.stringify(...))`. */
  log?: (summary: ReconcileSummary) => void
  /** Called for a per-actor resolve failure. Defaults to `console.error`. */
  onError?: (did: string, err: Error) => void
}

export interface ReconcileOptions {
  /** Concurrency of the fresh-snapshot fetches. Bounds outstanding work. */
  batchSize?: number
  /** Hard cap on actors examined this run (0 = no cap). Bounds total work. */
  maxActors?: number
}

export interface ReconcileSummary {
  /** Actors examined this run. */
  examined: number
  /** Actors fully purged because they are no longer enrolled. */
  unenrolled: number
  /** Actors whose boundary set shrank (some boundaries purged). */
  shrunk: number
  /** post rows removed across all purges. */
  postsPurged: number
  /** Per-actor resolve failures (skipped, left for the next run). */
  errors: number
}

const DEFAULT_BATCH_SIZE = 25

/**
 * Startup reconciliation. Compares the persisted `enrolled_actor`
 * snapshot against a fresh `resolveEnrollments` snapshot and purges anything
 * that has left scope while the feedgen was down (covering enroll/unenroll
 * events missed during downtime).
 *
 * Bounded: actors are processed in fixed-size batches (`batchSize`, default 25)
 * so at most that many upstream resolves and purges are outstanding at once,
 * and an optional `maxActors` cap limits total work per run. A resolve failure
 * for one actor is logged and skipped — it is left for the next boot rather
 * than aborting the whole pass.
 *
 * Only boundaries the feedgen actually tracks (`configuredBoundaries`) are
 * considered for the shrink case: a boundary the feedgen never synced can't
 * hold derived state to purge.
 *
 * Race guard: reconcile runs concurrently with live frame dispatch on the
 * same connection, so a resolve can report `enrolled: false` moments before
 * the live `enroll` frame for a re-enrolled actor is applied. Before any
 * purge, the actor's `enrolled_actor` row is re-read; a row written at or
 * after run start (or already deleted) means live state is fresher, and the
 * purge is skipped. A skipped purge is safe — the next reconcile converges.
 */
export async function reconcileEnrollments(
  deps: ReconcileDeps,
  configuredBoundaries: Set<string>,
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  // Guard the batching loop: a zero or negative batch size would never
  // advance the loop index (an empty batch each pass - infinite loop).
  // Treat non-positive values as unset and fall back to the default.
  const batchSize =
    opts.batchSize !== undefined && opts.batchSize > 0
      ? opts.batchSize
      : DEFAULT_BATCH_SIZE
  const maxActors = opts.maxActors ?? 0
  const log = deps.log ?? defaultLog
  const onError = deps.onError ?? defaultOnError

  const runStartedAt = new Date().toISOString()
  const all = await deps.store.listEnrolledActors()
  const actors = maxActors > 0 ? all.slice(0, maxActors) : all

  const summary: ReconcileSummary = {
    examined: 0,
    unenrolled: 0,
    shrunk: 0,
    postsPurged: 0,
    errors: 0,
  }

  for (let i = 0; i < actors.length; i += batchSize) {
    const batch = actors.slice(i, i + batchSize)
    // Fan out the fresh-snapshot fetches (IO) concurrently to bound latency,
    // but apply the purges (writes) sequentially: the store may be a single
    // SQLite connection that cannot run overlapping write transactions.
    type Resolved =
      | {
          actor: EnrolledActor
          fresh: ResolveEnrollmentsResult
        }
      | { actor: EnrolledActor; error: Error }
    const resolved = await Promise.all(
      batch.map(async (actor): Promise<Resolved> => {
        try {
          const fresh = await deps.client.resolveEnrollments(actor.did)
          return { actor, fresh }
        } catch (err) {
          return { actor, error: err as Error }
        }
      }),
    )

    for (const entry of resolved) {
      summary.examined++
      if ('error' in entry) {
        summary.errors++
        onError(entry.actor.did, entry.error)
        continue
      }
      await reconcileActor(
        deps,
        configuredBoundaries,
        entry,
        summary,
        runStartedAt,
      )
    }
  }

  log(summary)
  return summary
}

/**
 * Apply one actor's fresh enrollment snapshot: purge on unenroll or boundary
 * shrink, and persist any changed snapshot (including pure expansions - an
 * expansion held only in memory would be invisible to the next reconcile, so
 * a later revocation of the expanded boundary would diff against the stale
 * persisted set and never purge it).
 */
async function reconcileActor(
  deps: ReconcileDeps,
  configuredBoundaries: Set<string>,
  entry: {
    actor: EnrolledActor
    fresh: ResolveEnrollmentsResult
  },
  summary: ReconcileSummary,
  runStartedAt: string,
): Promise<void> {
  const { actor, fresh } = entry
  await deps.purger.withDidScope(actor.did, (scope) =>
    reconcileActorWithinScope(
      deps,
      configuredBoundaries,
      actor,
      fresh,
      summary,
      runStartedAt,
      scope,
    ),
  )
}

async function reconcileActorWithinScope(
  deps: ReconcileDeps,
  configuredBoundaries: Set<string>,
  actor: EnrolledActor,
  fresh: ResolveEnrollmentsResult,
  summary: ReconcileSummary,
  runStartedAt: string,
  scope: DidMutationScope,
): Promise<void> {
  if (didMutationPending(deps, actor.did)) return
  if (!fresh.enrolled) {
    await reconcileUnenrolledActor(deps, actor, summary, runStartedAt, scope)
    return
  }

  await reconcileEnrolledActor(
    deps,
    configuredBoundaries,
    actor,
    fresh,
    summary,
    runStartedAt,
    scope,
  )
}

async function reconcileUnenrolledActor(
  deps: ReconcileDeps,
  actor: EnrolledActor,
  summary: ReconcileSummary,
  runStartedAt: string,
  scope: DidMutationScope,
): Promise<void> {
  if (await touchedSinceRunStart(deps.store, actor.did, runStartedAt)) return
  if (didMutationPending(deps, actor.did)) return
  let counts: PurgeCounts
  if (deps.actorPool) {
    await deps.actorPool.removeActorAndDrain(actor.did)
    if (didMutationPending(deps, actor.did)) return
    counts = await deps.purger.purgeReconciledActorAfterDrainWithinScope(scope)
  } else {
    counts = await deps.purger.purgeReconciledActorWithinScope(scope)
  }
  summary.unenrolled++
  summary.postsPurged += counts.posts
}

async function reconcileEnrolledActor(
  deps: ReconcileDeps,
  configuredBoundaries: Set<string>,
  actor: EnrolledActor,
  fresh: ResolveEnrollmentsResult,
  summary: ReconcileSummary,
  runStartedAt: string,
  scope: DidMutationScope,
): Promise<void> {
  const lost = lostConfiguredBoundaries(actor, fresh, configuredBoundaries)
  const canContinue = await purgeLostBoundaries(
    deps,
    actor,
    lost,
    summary,
    runStartedAt,
    scope,
  )
  if (!canContinue || !enrollmentChanged(actor, fresh, lost)) return
  if (await touchedSinceRunStart(deps.store, actor.did, runStartedAt)) return
  if (didMutationPending(deps, actor.did)) return
  await deps.store.upsertEnrolledActor({
    did: actor.did,
    boundaries: fresh.boundaries,
    enrolledAt: actor.enrolledAt,
    lastSeenAt: new Date().toISOString(),
  })
  if (didMutationPending(deps, actor.did)) return
  if (fresh.boundaries.some((boundary) => configuredBoundaries.has(boundary))) {
    deps.actorPool?.addActor(actor.did)
  }
}

function lostConfiguredBoundaries(
  actor: EnrolledActor,
  fresh: ResolveEnrollmentsResult,
  configuredBoundaries: ReadonlySet<string>,
): string[] {
  const freshSet = new Set(fresh.boundaries)
  return actor.boundaries.filter(
    (b) => configuredBoundaries.has(b) && !freshSet.has(b),
  )
}

function enrollmentChanged(
  actor: EnrolledActor,
  fresh: ResolveEnrollmentsResult,
  lost: readonly string[],
): boolean {
  const persistedSet = new Set(actor.boundaries)
  return (
    lost.length > 0 ||
    fresh.boundaries.length !== actor.boundaries.length ||
    fresh.boundaries.some((b) => !persistedSet.has(b))
  )
}

async function purgeLostBoundaries(
  deps: ReconcileDeps,
  actor: EnrolledActor,
  lost: readonly string[],
  summary: ReconcileSummary,
  runStartedAt: string,
  scope: DidMutationScope,
): Promise<boolean> {
  if (lost.length === 0) return true
  if (await touchedSinceRunStart(deps.store, actor.did, runStartedAt)) {
    return false
  }
  if (didMutationPending(deps, actor.did)) return false
  await deps.actorPool?.removeActorAndDrain(actor.did)
  if (didMutationPending(deps, actor.did)) return false
  for (const boundary of lost) {
    if (didMutationPending(deps, actor.did)) return false
    const result =
      await deps.purger.purgeReconciledActorBoundaryGuardedWithinScope(
        scope,
        boundary,
        () => !didMutationPending(deps, actor.did),
      )
    if (!result.committed) return false
    summary.postsPurged += result.counts.posts
    if (didMutationPending(deps, actor.did)) return false
  }
  summary.shrunk++
  return true
}

function didMutationPending(deps: ReconcileDeps, did: string): boolean {
  return deps.mutationFence?.hasPendingDidMutation(did) ?? false
}

/**
 * Whether a live enroll/boundary frame wrote the actor's row at or after run
 * start, or a live unenroll already removed it. In both cases the fresh
 * upstream snapshot for this actor is stale and the purge must be skipped —
 * `lastSeenAt` is only written by the live frame path and by reconcile
 * itself, so it is a reliable touched-since marker.
 */
async function touchedSinceRunStart(
  store: FeedgenStore,
  did: string,
  runStartedAt: string,
): Promise<boolean> {
  const current = await store.getEnrolledActor(did)
  return current === null || current.lastSeenAt >= runStartedAt
}

function defaultLog(summary: ReconcileSummary): void {
  console.log(JSON.stringify({ msg: 'feedgen.reconcile', ...summary }))
}

function defaultOnError(did: string, err: Error): void {
  console.error(`reconcile: failed to resolve ${did}:`, err)
}
