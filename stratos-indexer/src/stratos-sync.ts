import { decodeFirst } from '@atcute/cbor'
import type { Kysely } from '@atproto/bsky/dist/data-plane/server/db/types'
import type { DatabaseSchemaType } from '@atproto/bsky/dist/data-plane/server/db/database-schema'
import { StratosError } from '@northskysocial/stratos-core'
import type { CursorManager } from './cursor-manager.ts'
import { ActorSyncer } from './actor-syncer.ts'

export interface StratosActorSyncOptions {
  maxConcurrentActorSyncs: number
  maxActorQueueSize: number
  globalMaxPending: number
  drainDelayMs: number
  maxConnections: number
  connectDelayMs: number
  idleEvictionMs: number
  reconnectBaseDelayMs: number
  reconnectMaxDelayMs: number
  reconnectJitterMs: number
  reconnectMaxAttempts: number
}

export interface StratosSyncConfig {
  stratosServiceUrl: string
  syncToken: string
}

interface EnrollmentMessage {
  did: string
  action: 'enroll' | 'unenroll'
  service?: string
  boundaries?: string[]
  time: string
}

export interface StratosSyncCallbacks {
  onEnroll: (did: string, boundaries: string[]) => void
  onUnenroll: (did: string) => void
}

const DEFAULT_ACTOR_SYNC_OPTIONS: StratosActorSyncOptions = {
  maxConcurrentActorSyncs: 50,
  maxActorQueueSize: 1000,
  globalMaxPending: 10000,
  drainDelayMs: 100,
  maxConnections: 500,
  connectDelayMs: 10,
  idleEvictionMs: 30 * 60 * 1000,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 60000,
  reconnectJitterMs: 500,
  reconnectMaxAttempts: 10,
}

// --- Service-level enrollment stream ---

export class StratosServiceSubscription {
  private ws: WebSocket | null = null
  private running = false
  private reconnectAttempt = 0

  constructor(
    private config: StratosSyncConfig,
    private callbacks: StratosSyncCallbacks,
    private onError?: (err: Error) => void,
  ) {}

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start(): void {
    this.running = true
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Connect to the Stratos service enrollment stream.
   */
  private connect(): void {
    if (!this.running) return

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl, {
      syncToken: this.config.syncToken,
    })

    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0
    })

    this.ws.onmessage = (e: MessageEvent) => {
      this.handleMessage(new Uint8Array(e.data as ArrayBuffer))
    }

    this.ws.onerror = (e: Event & { error?: unknown }) => {
      const cause = e.error instanceof Error ? e.error : undefined
      this.onError?.(
        new StratosError(`Enrollment stream error: ${e.error || 'unknown'}`, {
          cause,
        }),
      )
    }

    this.ws.onclose = () => {
      this.ws = null
      if (this.running) {
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000)
    setTimeout(() => this.connect(), delay)
  }

  private async handleMessage(data: Uint8Array): Promise<void> {
    try {
      const msg = decodeFirst(data) as Record<string, unknown>
      if (msg.t === '#enrollment') {
        const enrollment = msg as unknown as EnrollmentMessage
        if (enrollment.action === 'enroll') {
          this.callbacks.onEnroll(enrollment.did, enrollment.boundaries || [])
        } else if (enrollment.action === 'unenroll') {
          this.callbacks.onUnenroll(enrollment.did)
        }
      }
    } catch (err) {
      this.onError?.(err as Error)
    }
  }
}

// --- Main Sync Manager ---

export class StratosActorSync {
  private static readonly KNOWN_DIDS_TTL_MS = 30 * 60 * 1000
  private static readonly KNOWN_DIDS_SWEEP_MS = 60 * 1000
  private static readonly IDLE_EVICTION_CHECK_MS = 10_000
  private static readonly STATS_INTERVAL_MS = 10_000
  private syncers = new Map<string, ActorSyncer>()
  private running = false
  private knownDids = new Map<string, number>()
  private knownDidsSweepTimer: ReturnType<typeof setInterval> | null = null
  private waitingActors: string[] = []
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private activeSyncs = 0
  private globalPendingCount = 0
  private readonly options: StratosActorSyncOptions
  private idleEvictionTimer: ReturnType<typeof setInterval> | null = null
  private indexedCount = 0
  private deletedCount = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private db: Kysely<DatabaseSchemaType>,
    private config: StratosSyncConfig,
    private cursorManager: CursorManager,
    private onError?: (err: Error) => void,
    private onReferencedActor?: (did: string) => void,
    options: Partial<StratosActorSyncOptions> = {},
    private onHandleNeeded?: (did: string) => void,
  ) {
    this.options = { ...DEFAULT_ACTOR_SYNC_OPTIONS, ...options }
  }

  /**
   * Start the Stratos sync process.
   */
  start(): void {
    this.running = true
    this.statsTimer = setInterval(() => {
      if (this.indexedCount > 0 || this.deletedCount > 0) {
        console.log(
          {
            indexed: this.indexedCount,
            deleted: this.deletedCount,
            activeActors: this.syncers.size,
          },
          'stratos sync stats',
        )
        this.indexedCount = 0
        this.deletedCount = 0
      }
    }, StratosActorSync.STATS_INTERVAL_MS)

    this.knownDidsSweepTimer = setInterval(() => {
      const cutoff = Date.now() - StratosActorSync.KNOWN_DIDS_TTL_MS
      for (const [did, ts] of this.knownDids) {
        if (ts < cutoff) this.knownDids.delete(did)
      }
    }, StratosActorSync.KNOWN_DIDS_SWEEP_MS)

    if (this.options.idleEvictionMs > 0) {
      this.idleEvictionTimer = setInterval(
        () => this.evictIdleConnections(),
        StratosActorSync.IDLE_EVICTION_CHECK_MS,
      )
    }
  }

  /**
   * Stop the Stratos sync process.
   */
  stop(): void {
    this.running = false
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    if (this.knownDidsSweepTimer) {
      clearInterval(this.knownDidsSweepTimer)
      this.knownDidsSweepTimer = null
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.idleEvictionTimer) {
      clearInterval(this.idleEvictionTimer)
      this.idleEvictionTimer = null
    }

    for (const syncer of this.syncers.values()) {
      syncer.stop()
    }
    this.syncers.clear()
    this.waitingActors = []
  }

  /**
   * Add a new actor to the sync process.
   * @param did - Decentralized Identifier (DID) of the actor to add.
   * @param cursor - Optional cursor position for the actor.
   */
  addActor(did: string, cursor?: number): void {
    if (this.syncers.has(did)) return
    if (cursor !== undefined) {
      this.cursorManager.updateStratosCursor(did, cursor)
    }

    if (!this.waitingActors.includes(did)) {
      this.waitingActors.push(did)
      this.scheduleConnect()
    }
  }

  /**
   * Remove an actor from the sync process.
   * @param did - Decentralized Identifier (DID) of the actor to remove.
   */
  removeActor(did: string): void {
    const syncer = this.syncers.get(did)
    if (syncer) {
      syncer.stop()
      this.syncers.delete(did)
    }
    this.waitingActors = this.waitingActors.filter((a) => a !== did)
    this.cursorManager.removeStratosCursor(did)
  }

  /**
   * Mark a list of DIDs as known to the indexer.
   * @param dids - List of DIDs to mark as known.
   */
  markKnown(dids: string[]): void {
    const now = Date.now()
    for (const did of dids) {
      this.knownDids.set(did, now)
    }
  }

  /**
   * Get statistics about the current state of the indexer.
   */
  getStats() {
    return {
      activeConnections: this.syncers.size,
      waitingActors: this.waitingActors.length,
      globalPending: this.globalPendingCount,
      activeSyncs: this.activeSyncs,
    }
  }

  /**
   * Schedule a connection attempt to a waiting actor.
   * @private
   */
  private scheduleConnect(): void {
    if (this.connectTimer || !this.running || this.waitingActors.length === 0)
      return

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      this.promoteWaitingActor()
      this.scheduleConnect()
    }, this.options.connectDelayMs)
  }

  /**
   * Promote a waiting actor to a connected actor.
   * @private
   */
  private promoteWaitingActor(): void {
    if (this.syncers.size >= this.options.maxConnections) return
    const did = this.waitingActors.shift()
    if (!did) return

    const syncer = new ActorSyncer(did, this.db, this.cursorManager, {
      stratosServiceUrl: this.config.stratosServiceUrl,
      syncToken: this.config.syncToken,
      maxActorQueueSize: this.options.maxActorQueueSize,
      drainDelayMs: this.options.drainDelayMs,
      reconnectBaseDelayMs: this.options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.options.reconnectMaxDelayMs,
      reconnectJitterMs: this.options.reconnectJitterMs,
      reconnectMaxAttempts: this.options.reconnectMaxAttempts,
      onReferencedActor: this.onReferencedActor,
      onHandleNeeded: this.onHandleNeeded,
      onError: this.onError,
      onIndexed: (count) => {
        this.indexedCount += count
      },
      onDeleted: (count) => {
        this.deletedCount += count
      },
      onConnectionStatusChange: (did, connected) => {
        if (!connected && !this.waitingActors.includes(did)) {
          // handled by ActorSyncer internal reconnect
        }
      },
      onGlobalPendingChange: (delta) => {
        this.globalPendingCount += delta
      },
      canStartSync: () =>
        this.activeSyncs < this.options.maxConcurrentActorSyncs &&
        this.globalPendingCount < this.options.globalMaxPending,
      onSyncStarted: () => {
        this.activeSyncs++
      },
      onSyncFinished: () => {
        this.activeSyncs--
      },
    })

    this.syncers.set(did, syncer)
    syncer.start()
  }

  /**
   * Evict idle connections from the indexer.
   * @private
   */
  private evictIdleConnections(): void {
    if (this.waitingActors.length === 0) return

    const now = Date.now()
    const entries = Array.from(this.syncers.entries())
    // Find connections that haven't received a message in a while
    const idle = entries
      .filter(
        ([, syncer]) =>
          now - syncer.getLastMessageAt() > this.options.idleEvictionMs,
      )
      .sort((a, b) => a[1].getLastMessageAt() - b[1].getLastMessageAt())

    if (idle.length === 0) return

    // Evict up to 10% of max connections or the number of waiters
    const toEvictCount = Math.min(
      idle.length,
      this.waitingActors.length,
      Math.ceil(this.options.maxConnections * 0.1),
    )

    for (let i = 0; i < toEvictCount; i++) {
      const [did, syncer] = idle[i]
      syncer.stop()
      this.syncers.delete(did)
      this.waitingActors.push(did)
    }
  }
}

/**
 * Build a WebSocket URL for the Stratos service.
 * @param serviceUrl - The base URL of the Stratos service.
 * @param params - Query parameters for the WebSocket URL.
 * @returns The WebSocket URL for the Stratos service.
 */
function buildWsUrl(
  serviceUrl: string,
  params: Record<string, unknown>,
): string {
  const url = new URL(serviceUrl.replace(/^http/, 'ws'))
  url.pathname = '/xrpc/zone.stratos.sync.subscribeRecords'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}
