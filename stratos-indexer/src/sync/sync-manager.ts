import {
  StratosActorSync,
  StratosServiceSubscription,
  type StratosSyncConfig,
} from './stratos-sync.js'
import type { CursorManager } from '../storage/cursor-manager.js'
import type { EnrollmentCallback } from '../pds/pds-firehose.js'
import { Kysely } from 'kysely'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { BackfillOptions } from '../backfill.js'
import type { StratosIndexerSchema } from '../storage/schema.js'
import { BackgroundQueue } from '@atproto/bsky'

/**
 * Options for the Stratos sync manager.
 * @interface
 */
export interface StratosSyncManagerOptions {
  config: {
    stratos: {
      serviceUrl: string
      syncToken: string
    }
    worker: {
      actorSyncConcurrency: number
      actorSyncQueuePerActor: number
      actorSyncGlobalMaxPending: number
      actorSyncDrainDelayMs: number
      actorSyncMaxConnections: number
      actorSyncConnectDelayMs: number
      actorSyncIdleEvictionMs: number
      actorSyncReconnectBaseDelayMs: number
      actorSyncReconnectMaxDelayMs: number
      actorSyncReconnectJitterMs: number
      actorSyncReconnectMaxAttempts: number
    }
    pds: {
      enrolledOnly: boolean
    }
  }
  db: Kysely<StratosIndexerSchema>
  cursorManager: CursorManager
  indexingService: IndexingService
  background: BackgroundQueue
  enrollmentCallback: EnrollmentCallback
  onReferencedActorBackfill: (
    did: string,
    opts: BackfillOptions,
  ) => Promise<void>
  onError?: (err: Error) => void
}

/**
 * A Stratos sync manager that manages the synchronization of actors and records from a Stratos service.
 * @class
 */
export class StratosSyncManager {
  private serviceSub: StratosServiceSubscription
  private actorSync: StratosActorSync

  constructor(opts: StratosSyncManagerOptions) {
    const syncConfig: StratosSyncConfig = {
      stratosServiceUrl: opts.config.stratos.serviceUrl,
      syncToken: opts.config.stratos.syncToken,
    }

    const backfillOpts: BackfillOptions = {
      repoProvider: '', // This will be set by the caller if needed or we should pass it
      indexingService: opts.indexingService,
      enrollmentCallback: opts.enrollmentCallback,
      concurrency: opts.config.worker.actorSyncConcurrency,
      onError: (err: Error) =>
        console.error({ err: err.message }, 'Sync Manager backfill error'),
    }

    this.actorSync = new StratosActorSync(
      (opts.db as unknown as { db: Kysely<StratosIndexerSchema> }).db,
      syncConfig,
      opts.cursorManager,
      (err) => {
        if (opts.onError) {
          opts.onError(err)
        } else {
          console.error({ err: err.message }, 'Sync Manager actor sync error')
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      opts.config.pds.enrolledOnly
        ? (did) => opts.onReferencedActorBackfill(did, backfillOpts)
        : undefined,
      {
        maxConcurrentActorSyncs: opts.config.worker.actorSyncConcurrency,
        maxActorQueueSize: opts.config.worker.actorSyncQueuePerActor,
        globalMaxPending: opts.config.worker.actorSyncGlobalMaxPending,
        drainDelayMs: opts.config.worker.actorSyncDrainDelayMs,
        maxConnections: opts.config.worker.actorSyncMaxConnections,
        connectDelayMs: opts.config.worker.actorSyncConnectDelayMs,
        idleEvictionMs: opts.config.worker.actorSyncIdleEvictionMs,
        reconnectBaseDelayMs: opts.config.worker.actorSyncReconnectBaseDelayMs,
        reconnectMaxDelayMs: opts.config.worker.actorSyncReconnectMaxDelayMs,
        reconnectJitterMs: opts.config.worker.actorSyncReconnectJitterMs,
        reconnectMaxAttempts: opts.config.worker.actorSyncReconnectMaxAttempts,
      },
      (did) => {
        const background = opts.background as unknown as {
          add: (fn: () => void) => void
        }
        background.add(() => {
          void opts.indexingService.indexHandle(did, new Date().toISOString())
        })
      },
    )

    this.serviceSub = new StratosServiceSubscription(
      syncConfig,
      {
        onEnroll: (did, boundaries) => {
          opts.enrollmentCallback.onEnrollmentDiscovered(
            did,
            opts.config.stratos.serviceUrl,
            boundaries,
          )
        },
        onUnenroll: (did) => {
          opts.enrollmentCallback.onEnrollmentRemoved(did)
        },
      },
      (err) => {
        if (opts.onError) {
          opts.onError(err)
        } else {
          console.error({ err: err.message }, 'Sync Manager service sub error')
        }
      },
    )
  }

  /**
   * Start the Stratos sync manager by starting the actor sync and service subscription.
   */
  start(): void {
    this.actorSync.start()
    this.serviceSub.start()
  }

  /**
   * Stop the Stratos sync manager by stopping the actor sync and service subscription.
   */
  stop(): void {
    this.serviceSub.stop()
    this.actorSync.stop()
  }

  /**
   * Check if the Stratos sync manager is connected to the Stratos service.
   * @returns true if the service is connected, false otherwise.
   */
  isConnected(): boolean {
    return this.serviceSub.isConnected()
  }

  /**
   * Add an actor to the Stratos sync manager.
   * @param did - The DID of the actor to add.
   */
  addActor(did: string): void {
    this.actorSync.addActor(did)
  }

  /**
   * Remove an actor from the Stratos sync manager.
   * @param did - The DID of the actor to remove.
   */
  removeActor(did: string): void {
    this.actorSync.removeActor(did)
  }

  /**
   * Get statistics about the Stratos sync manager.
   * @returns An object containing statistics about the sync manager.
   */
  getStats(): Record<string, number> {
    try {
      return this.actorSync.getStats()
    } catch (err) {
      console.error({ err }, 'failed to get sync manager stats')
      return { activeConnections: 0, waitingActors: 0 }
    }
  }

  /**
   * Get active actors in the Stratos sync manager.
   * @returns An array of DIDs of active actors.
   */
  getActiveActors(): string[] {
    return this.actorSync.getActiveActors()
  }
}
