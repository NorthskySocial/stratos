import {
  StratosActorSync,
  StratosServiceSubscription,
  type StratosSyncConfig,
} from './stratos-sync.js'
import type { CursorManager } from './cursor-manager.js'
import type { EnrollmentCallback } from './pds-firehose.js'
import type { Kysely } from '@atproto/bsky/dist/data-plane/server/db/types'
import type { DatabaseSchemaType } from '@atproto/bsky/dist/data-plane/server/db/database-schema'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { BackgroundQueue } from '@atproto/bsky/dist/background.js'
import type { BackfillOptions } from './backfill.js'

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
  db: Kysely<DatabaseSchemaType>
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
      opts.db as never,
      syncConfig,
      opts.cursorManager,
      (err) => {
        if (opts.onError) {
          opts.onError(err)
        } else {
          console.error({ err: err.message }, 'Sync Manager actor sync error')
        }
      },
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
      (did) =>
        opts.background.add(() =>
          opts.indexingService.indexHandle(did, new Date().toISOString()),
        ),
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

  start() {
    this.actorSync.start()
    this.serviceSub.start()
  }

  stop() {
    this.serviceSub.stop()
    this.actorSync.stop()
  }

  isConnected(): boolean {
    return this.serviceSub.isConnected()
  }

  async addActor(did: string) {
    await this.actorSync.addActor(did)
  }

  removeActor(did: string) {
    this.actorSync.removeActor(did)
  }

  getStats() {
    return this.actorSync.getStats()
  }

  getActiveActors() {
    return this.actorSync.getActiveActors()
  }
}
