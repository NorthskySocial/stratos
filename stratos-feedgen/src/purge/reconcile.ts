import type { EnrolledActor, FeedgenStore } from '../db/index.js'
import type { ResolveEnrollmentsResult } from '../upstream/index.js'
import type { Purger } from './purger.js'

export interface ReconcileEnrollmentsClient {
  resolveEnrollments: (did: string) => Promise<ResolveEnrollmentsResult>
}

export interface ReconcileDeps {
  store: FeedgenStore
  purger: Purger
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
      | { actor: EnrolledActor; fresh: ResolveEnrollmentsResult }
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
      const { actor, fresh } = entry

      if (!fresh.enrolled) {
        const counts = await deps.purger.purgeActor(
          actor.did,
          'reconcile-unenroll',
        )
        summary.unenrolled++
        summary.postsPurged += counts.posts
        continue
      }

      // Still enrolled: purge any configured boundary the actor held before
      // but no longer does, then refresh the persisted snapshot.
      const freshSet = new Set(fresh.boundaries)
      const lost = actor.boundaries.filter(
        (b) => configuredBoundaries.has(b) && !freshSet.has(b),
      )
      if (lost.length > 0) {
        summary.shrunk++
        for (const boundary of lost) {
          const counts = await deps.purger.purgeActorBoundary(
            actor.did,
            boundary,
            'reconcile-boundary-shrink',
          )
          summary.postsPurged += counts.posts
        }
        await deps.store.upsertEnrolledActor({
          did: actor.did,
          boundaries: fresh.boundaries,
          enrolledAt: actor.enrolledAt,
          lastSeenAt: new Date().toISOString(),
        })
      }
    }
  }

  log(summary)
  return summary
}

function defaultLog(summary: ReconcileSummary): void {
  console.log(JSON.stringify({ msg: 'feedgen.reconcile', ...summary }))
}

function defaultOnError(did: string, err: Error): void {
  console.error(`reconcile: failed to resolve ${did}:`, err)
}
