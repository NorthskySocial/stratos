import type { FeedgenStore } from '../db/index.js'
import type { ActorPool } from '../subscription/actor-pool.js'
import type { Purger } from '../purge/purger.js'
import type { MembershipTracker } from '../space-sync/membership.js'
import type { SpaceSyncScheduler } from '../space-sync/scheduler.js'
import type { CatalogBoundary } from './catalog-model.js'

export interface CatalogSubscription {
  actorPool: Pick<ActorPool, 'start' | 'stop' | 'seedFromStore'>
  reconcile: (signal: AbortSignal) => Promise<boolean>
}

export interface CatalogSpaceRuntime {
  membership: Pick<MembershipTracker, 'runPass'>
  scheduler: Pick<SpaceSyncScheduler, 'start' | 'stop' | 'abortActivePass'>
}

export interface BoundaryCatalogRuntimeDeps {
  store: FeedgenStore
  configuredBoundaries: Set<string>
  enrollment: { clear: () => void }
  credentials: { clear: () => void }
  blobs: { clear: () => Promise<void> }
  purger: () => Pick<Purger, 'purgeBoundary'>
  subscription: () => CatalogSubscription | null
  createSpaces: () => CatalogSpaceRuntime
  spaceSyncEnabled: boolean
}

/** Drains the old projection writers before changing their shared authority scope. */
export class BoundaryCatalogRuntime {
  private spaces: CatalogSpaceRuntime | undefined

  constructor(private readonly deps: BoundaryCatalogRuntimeDeps) {}

  async suspend(): Promise<void> {
    this.spaces?.scheduler.abortActivePass()
    await Promise.all([
      this.spaces?.scheduler.stop(),
      this.deps.subscription()?.actorPool.stop(),
    ])
    this.deps.enrollment.clear()
    this.deps.credentials.clear()
  }

  async apply(
    previous: readonly CatalogBoundary[],
    next: readonly CatalogBoundary[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const nextByBoundary = new Map(next.map((entry) => [entry.boundary, entry]))
    const changed = new Set(
      (await this.deps.store.listIndexedBoundaries()).filter(
        (boundary) => !nextByBoundary.has(boundary),
      ),
    )
    for (const entry of previous) {
      if (
        JSON.stringify(entry) !==
        JSON.stringify(nextByBoundary.get(entry.boundary))
      )
        changed.add(entry.boundary)
    }
    for (const entry of next) {
      if (!previous.some((prior) => prior.boundary === entry.boundary))
        changed.add(entry.boundary)
    }
    if (changed.size > 0) await this.deps.blobs.clear()
    for (const boundary of changed) {
      signal.throwIfAborted()
      await this.deps.purger().purgeBoundary(boundary)
      await this.deps.store.replaceSpaceMembers(boundary, [])
    }
    signal.throwIfAborted()
    for (const entry of next) this.deps.configuredBoundaries.add(entry.boundary)
    this.spaces = this.deps.createSpaces()
    const membership = await this.spaces.membership.runPass(
      this.deps.configuredBoundaries,
      signal,
    )
    if (membership.some((outcome) => !outcome.ok))
      throw new Error('Boundary membership discovery is incomplete')
    await this.discoverMembers(next, signal)
    const affected = new Set(
      (await this.deps.store.listEnrolledActors())
        .filter((actor) =>
          actor.boundaries.some((boundary) => changed.has(boundary)),
        )
        .map((actor) => actor.did),
    )
    const subscription = this.deps.subscription()
    if (!subscription || !(await subscription.reconcile(signal)))
      throw new Error('Boundary enrollment reconciliation is incomplete')
    signal.throwIfAborted()
    for (const actor of await this.deps.store.listEnrolledActors()) {
      signal.throwIfAborted()
      if (
        affected.has(actor.did) ||
        actor.boundaries.some((boundary) => changed.has(boundary))
      )
        await this.deps.store.deleteCursor(actor.did)
    }
    subscription.actorPool.start()
    await subscription.actorPool.seedFromStore(this.deps.configuredBoundaries)
    signal.throwIfAborted()
    if (this.deps.spaceSyncEnabled) this.spaces.scheduler.start()
  }

  private async discoverMembers(
    boundaries: readonly CatalogBoundary[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const { boundary } of boundaries) {
      for (const member of await this.deps.store.listSpaceMembers(boundary)) {
        signal.throwIfAborted()
        if (await this.deps.store.getEnrolledActor(member.did)) continue
        // Only an authoritative listRepos result discovers actors. Reconciliation resolves their actual enrollment.
        await this.deps.store.deleteCursor(member.did)
        await this.deps.store.upsertEnrolledActor({
          did: member.did,
          boundaries: [],
          enrolledAt: new Date().toISOString(),
          lastSeenAt: '1970-01-01T00:00:00.000Z',
        })
      }
    }
  }
}
