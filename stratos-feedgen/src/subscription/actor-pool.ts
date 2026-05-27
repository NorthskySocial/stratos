// copied from stratos-indexer/src/sync/stratos-sync.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// (specifically the `StratosActorSync` class). Stripped of bsky-specific
// concerns: no IndexingService/BackgroundQueue wiring, no referenced-actor
// discovery, no known-DIDs cache. Idle eviction is retained but gated on
// cap pressure (only evicts when there are waiting actors to promote).
import type { FeedgenStore } from '../db/index.js'
import { ActorSyncer, type ActorSyncerConfig } from './actor-syncer.js'
import type { SubscriptionIndexer } from './indexer.js'

type SyncerCtor = (
  config: ActorSyncerConfig,
  deps: ConstructorParameters<typeof ActorSyncer>[1],
) => ActorSyncer

interface SyncerLike {
  start: () => void
  stop: () => void
  setConnectGate: (gate: (() => Promise<void>) | null) => void
  getLastMessageAt: () => number
}

export interface ActorPoolConfig {
  stratosServiceUrl: string
  mintToken: () => Promise<string>
  maxConnections?: number
  connectDelayMs?: number
  /** Evict an active syncer idle for longer than this when waiters exist. 0 disables. */
  idleEvictionMs?: number
  /** How often to scan for idle syncers. */
  evictionCheckIntervalMs?: number
  syncerBaseDelayMs?: number
  syncerMaxDelayMs?: number
  syncerJitterRatio?: number
  syncerMaxQueueSize?: number
}

export interface ActorPoolDeps {
  store: FeedgenStore
  indexer: SubscriptionIndexer
  onError?: (err: Error) => void
  syncerFactory?: SyncerCtor
  rng?: () => number
  now?: () => number
}

const DEFAULT_MAX_CONNECTIONS = 500
const DEFAULT_CONNECT_DELAY_MS = 10
const DEFAULT_IDLE_EVICTION_MS = 15 * 60 * 1000
const DEFAULT_EVICTION_CHECK_INTERVAL_MS = 60 * 1000

/**
 * Manages a pool of per-actor `ActorSyncer`s with a global concurrency cap.
 * Actors beyond the cap are kept in a FIFO waiting list; when an active
 * syncer is removed (unenroll/stop) the next waiting actor is promoted.
 */
export class ActorPool {
  private active = new Map<string, ActorSyncer>()
  private waiting: string[] = []
  private requested = new Set<string>()
  private running = false
  private readonly maxConnections: number
  private readonly connectDelayMs: number
  private readonly idleEvictionMs: number
  private readonly evictionCheckIntervalMs: number
  private readonly syncerFactory: SyncerCtor
  private readonly now: () => number
  private lastConnectAt = 0
  private evictionTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: ActorPoolConfig,
    private deps: ActorPoolDeps,
  ) {
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    this.connectDelayMs = config.connectDelayMs ?? DEFAULT_CONNECT_DELAY_MS
    this.idleEvictionMs = config.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS
    this.evictionCheckIntervalMs =
      config.evictionCheckIntervalMs ?? DEFAULT_EVICTION_CHECK_INTERVAL_MS
    this.syncerFactory = deps.syncerFactory ?? ((c, d) => new ActorSyncer(c, d))
    this.now = deps.now ?? Date.now
  }

  start(): void {
    this.running = true
    if (this.idleEvictionMs > 0 && !this.evictionTimer) {
      this.evictionTimer = setInterval(
        () => this.evictIdle(),
        this.evictionCheckIntervalMs,
      )
      // Don't keep the event loop alive for this housekeeping task.
      this.evictionTimer.unref?.()
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }
    for (const syncer of this.active.values()) {
      syncer.stop()
    }
    this.active.clear()
    this.waiting = []
    this.requested.clear()
  }

  /**
   * Track and (if capacity allows) start a syncer for `did`. Idempotent.
   * Returns true if the actor is now in the pool (active or waiting).
   */
  addActor(did: string): boolean {
    if (!this.running) return false
    if (this.requested.has(did)) return true
    this.requested.add(did)
    if (this.active.size < this.maxConnections) {
      this.startSyncer(did)
    } else {
      this.waiting.push(did)
    }
    return true
  }

  /** Stop and remove a syncer; promote a waiting actor if one is queued. */
  removeActor(did: string): void {
    this.requested.delete(did)
    const syncer = this.active.get(did)
    if (syncer) {
      syncer.stop()
      this.active.delete(did)
      this.promoteNext()
      return
    }
    const idx = this.waiting.indexOf(did)
    if (idx >= 0) this.waiting.splice(idx, 1)
  }

  getActiveActors(): string[] {
    return [...this.active.keys()]
  }

  getWaitingActors(): string[] {
    return [...this.waiting]
  }

  getStats(): { active: number; waiting: number; max: number } {
    return {
      active: this.active.size,
      waiting: this.waiting.length,
      max: this.maxConnections,
    }
  }

  /**
   * Rotate idle active syncers out to make room for waiting actors. Only
   * runs when there are waiters — otherwise eviction would just churn
   * healthy connections. Evicted DIDs go to the back of the waiting list
   * (they remain enrolled) and the freed slots are filled by `promoteNext`.
   *
   * Returns the DIDs that were evicted.
   */
  evictIdle(): string[] {
    if (!this.running || this.idleEvictionMs <= 0) return []
    if (this.waiting.length === 0) return []
    const cutoff = this.now() - this.idleEvictionMs
    const idle: Array<{ did: string; lastMessageAt: number }> = []
    for (const [did, syncer] of this.active) {
      const lastMessageAt = (syncer as SyncerLike).getLastMessageAt()
      if (lastMessageAt < cutoff) {
        idle.push({ did, lastMessageAt })
      }
    }
    if (idle.length === 0) return []
    // Oldest first; cap by how many waiters we can actually promote.
    idle.sort((a, b) => a.lastMessageAt - b.lastMessageAt)
    const limit = Math.min(idle.length, this.waiting.length)
    const evicted: string[] = []
    for (let i = 0; i < limit; i++) {
      const did = idle[i].did
      const syncer = this.active.get(did)
      if (!syncer) continue
      syncer.stop()
      this.active.delete(did)
      // Keep `requested` — the actor is still enrolled, just cycled out.
      this.waiting.push(did)
      evicted.push(did)
    }
    this.promoteNext()
    return evicted
  }

  /**
   * Seed the pool from persisted enrollments at startup. Only DIDs whose
   * boundaries intersect `configuredBoundaries` are added.
   */
  async seedFromStore(configuredBoundaries: Set<string>): Promise<number> {
    const actors = await this.deps.store.listEnrolledActors()
    let added = 0
    for (const actor of actors) {
      if (intersects(actor.boundaries, configuredBoundaries)) {
        if (this.addActor(actor.did)) added++
      }
    }
    return added
  }

  private startSyncer(did: string): void {
    const syncer = this.syncerFactory(
      {
        did,
        stratosServiceUrl: this.config.stratosServiceUrl,
        mintToken: this.config.mintToken,
        baseDelayMs: this.config.syncerBaseDelayMs,
        maxDelayMs: this.config.syncerMaxDelayMs,
        jitterRatio: this.config.syncerJitterRatio,
        maxQueueSize: this.config.syncerMaxQueueSize,
      },
      {
        store: this.deps.store,
        indexer: this.deps.indexer,
        onError: this.deps.onError,
        rng: this.deps.rng,
      },
    )
    syncer.setConnectGate(() => this.acquireConnectSlot())
    this.active.set(did, syncer)
    syncer.start()
  }

  private promoteNext(): void {
    if (!this.running) return
    while (this.active.size < this.maxConnections && this.waiting.length > 0) {
      const did = this.waiting.shift()
      if (!did) break
      if (!this.requested.has(did)) continue
      this.startSyncer(did)
    }
  }

  /**
   * Spread connect attempts across the pool. Each connect waits at least
   * `connectDelayMs` after the previous one to avoid bursting the upstream.
   */
  private async acquireConnectSlot(): Promise<void> {
    if (this.connectDelayMs <= 0) return
    const wait = this.lastConnectAt + this.connectDelayMs - Date.now()
    this.lastConnectAt = Date.now() + Math.max(0, wait)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

function intersects(a: string[], b: Set<string>): boolean {
  for (const v of a) {
    if (b.has(v)) return true
  }
  return false
}

export { intersects as intersectsBoundaries }
