import type { IndexerConfig } from './config.ts'
import type { Database } from '@atproto/bsky'
import { Kysely, sql } from 'kysely'
import {
  createDatabase,
  createIdResolver,
  createIndexingService,
} from './db.ts'
import { HandleDedup } from './handle-dedup.ts'
import { CursorManager } from './cursor-manager.ts'
import { PdsSubscriber } from './pds-subscriber.js'
import { StratosSyncManager } from './sync-manager.js'
import {
  backfillActors,
  type BackfillOptions,
  backfillRepos,
  backfillSingleActor,
} from './backfill.js'
import { EnrollmentCallback } from './pds-firehose.ts'
import type { NewStratosSyncCursor, StratosIndexerSchema } from './schema.ts'

export class Indexer {
  private static readonly BACKFILLED_TTL_MS = 30 * 60 * 1000
  private db: Database | null = null
  private pdsSubscriber: PdsSubscriber | null = null
  private syncManager: StratosSyncManager | null = null
  private cursorManager: CursorManager | null = null
  private handleDedup: HandleDedup | null = null
  private healthServer: Deno.HttpServer | null = null
  private enrolledDids = new Set<string>()
  private backfilledDids = new Map<string, number>()
  private backfilledDidsSweepTimer: ReturnType<typeof setInterval> | null = null
  private activeBackfills = 0
  private readonly maxConcurrentBackfills = 2

  constructor(private config: IndexerConfig) {}

  /**
   * Start the indexer service
   */
  async start(): Promise<void> {
    console.log('starting stratos indexer')

    this.startBackfilledDidsSweepTimer()

    // Database
    const db = createDatabase(this.config.db)
    this.db = db

    const idResolver = createIdResolver(this.config.identity)
    const { indexingService, background } = createIndexingService(
      db,
      idResolver,
      this.config,
    )

    await this.initCursorManager(db)

    this.startHealthServer()

    // Handle dedup — skip redundant indexHandle calls for recently seen DIDs
    const handleDedup = new HandleDedup()
    this.handleDedup = handleDedup

    // Enrollment callbacks (defined first, referenced by PDS subscriber and Sync Manager)
    const enrollmentCallback = this.createEnrollmentCallback(
      indexingService,
      background,
    )

    const backfillOpts: BackfillOptions = {
      repoProvider: this.config.pds.repoProvider,
      indexingService,
      enrollmentCallback,
      concurrency: this.config.worker.actorSyncConcurrency,
      onError: (err: Error) =>
        console.error({ err: err.message }, 'backfill error'),
      onProgress: (processed: number) => {
        if (processed % 100 === 0) {
          console.log({ processed }, 'backfill progress')
        }
      },
    }

    // PDS Subscriber (Firehose + Worker Pool)
    this.pdsSubscriber = new PdsSubscriber({
      repoProvider: this.config.pds.repoProvider,
      indexingService,
      background,
      enrollmentCallback,
      handleDedup,
      concurrency: this.config.worker.concurrency,
      maxQueueSize: this.config.worker.maxQueueSize,
      onError: (err) =>
        console.error({ err: err.message }, 'pds subscriber error'),
    })

    // Stratos Sync Manager (Service Subscription + Per-actor Sync)
    this.syncManager = new StratosSyncManager({
      config: this.config,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      db: (db as any).db as Kysely<StratosIndexerSchema>,
      cursorManager: this.cursorManager!,
      indexingService,
      background,
      enrollmentCallback,
      onReferencedActorBackfill: (did, opts) =>
        this.backfillReferencedActor(did, opts),
      onError: (err) =>
        console.error({ err: err.message }, 'sync manager error'),
    })

    await this.runAllBackfills(indexingService, background, backfillOpts)

    this.pdsSubscriber.start()
    void this.syncManager.start()

    this.startStatsLogging()

    console.log(
      {
        healthPort: this.config.health.port,
        enrolledActors: this.enrolledDids.size,
        workerConcurrency: this.config.worker.concurrency,
        maxQueueSize: this.config.worker.maxQueueSize,
        actorSyncConcurrency: this.config.worker.actorSyncConcurrency,
        actorSyncQueuePerActor: this.config.worker.actorSyncQueuePerActor,
        actorSyncMaxConnections: this.config.worker.actorSyncMaxConnections,
        actorSyncConnectDelayMs: this.config.worker.actorSyncConnectDelayMs,
        actorSyncReconnectBaseDelayMs:
          this.config.worker.actorSyncReconnectBaseDelayMs,
        actorSyncReconnectMaxDelayMs:
          this.config.worker.actorSyncReconnectMaxDelayMs,
        actorSyncReconnectJitterMs:
          this.config.worker.actorSyncReconnectJitterMs,
        actorSyncReconnectMaxAttempts:
          this.config.worker.actorSyncReconnectMaxAttempts,
      },
      'stratos indexer started',
    )
  }

  /**
   * Stop the indexer service
   */
  async stop(): Promise<void> {
    if (!this.db) return // already stopped or not started
    console.log('stopping stratos indexer')

    // 1. Stop accepting new events/subscriptions
    this.pdsSubscriber?.stop()
    this.syncManager?.stop()

    // 2. Stop background tasks
    this.handleDedup?.stop()

    if (this.backfilledDidsSweepTimer) {
      clearInterval(this.backfilledDidsSweepTimer)
      this.backfilledDidsSweepTimer = null
    }
    this.backfilledDids.clear()

    // 3. Final cursor flush
    if (this.cursorManager) {
      console.log('flushing cursors')
      try {
        await this.cursorManager.stop()
      } catch (err) {
        console.error({ err }, 'failed to stop cursor manager')
      }
    }

    // 4. Shutdown health server
    if (this.healthServer) {
      try {
        void this.healthServer.shutdown()
      } catch (err) {
        console.error({ err }, 'failed to shutdown health server')
      }
    }

    // 5. Close database
    if (this.db) {
      try {
        await this.db.close()
      } catch (err) {
        console.error({ err }, 'failed to close database')
      }
      this.db = null
    }

    console.log('stratos indexer stopped')
  }

  /**
   * Start the backfilled DID sweep timer
   */
  private startBackfilledDidsSweepTimer(): void {
    this.backfilledDidsSweepTimer = setInterval(() => {
      const cutoff = Date.now() - Indexer.BACKFILLED_TTL_MS
      for (const [did, ts] of this.backfilledDids) {
        if (ts < cutoff) this.backfilledDids.delete(did)
      }
    }, 60_000)
  }

  private async checkDbHealth(): Promise<boolean> {
    try {
      if (this.db) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        const rawDb = (this.db as any).db as Kysely<StratosIndexerSchema>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await rawDb.execute(sql`SELECT 1`)
        return true
      }
    } catch (err) {
      console.error({ err }, 'health check: database error')
    }
    return false
  }

  private buildHealthResponse(
    url: URL,
    dbOk: boolean,
    firehoseOk: boolean,
    serviceSubOk: boolean,
    actorSyncStats: unknown,
    mem: Deno.MemoryUsage,
  ): Response {
    const isReady = dbOk && firehoseOk && serviceSubOk
    const isReadyPath = url.pathname === '/ready'
    const status = isReadyPath && !isReady ? 503 : 200

    const body = {
      status: isReady ? 'healthy' : 'degraded',
      db: dbOk ? 'connected' : 'disconnected',
      firehose: firehoseOk ? 'connected' : 'disconnected',
      stratosService: serviceSubOk ? 'connected' : 'disconnected',
      enrolledActors: this.enrolledDids.size,
      activeActorSyncs: this.syncManager?.getActiveActors().length ?? 0,
      workerPool: this.getWorkerPoolStats(),
      actorSync: actorSyncStats ?? null,
      memory: this.formatMemoryUsage(mem),
    }

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  private getWorkerPoolStats() {
    return {
      pending: this.pdsSubscriber?.stats.pendingCount ?? 0,
      active: this.pdsSubscriber?.stats.runningCount ?? 0,
    }
  }

  private formatMemoryUsage(mem: Deno.MemoryUsage) {
    return {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    }
  }

  private async handleHealthCheck(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname !== '/health' && url.pathname !== '/ready') {
      return new Response('not found', { status: 404 })
    }

    const mem = Deno.memoryUsage()
    const actorSyncStats = this.syncManager?.getStats()
    const dbOk = await this.checkDbHealth()

    // Check Firehose and Sync connections
    const firehoseOk = this.pdsSubscriber?.isConnected() ?? false
    const serviceSubOk = this.syncManager?.isConnected() ?? false

    return this.buildHealthResponse(
      url,
      dbOk,
      firehoseOk,
      serviceSubOk,
      actorSyncStats,
      mem,
    )
  }

  /**
   * Start the health server
   */
  private startHealthServer(): void {
    this.healthServer = Deno.serve({ port: this.config.health.port }, (req) => {
      try {
        return this.handleHealthCheck(req)
      } catch (err) {
        console.error({ err }, 'failed to handle health check')
        return new Response('internal server error', { status: 500 })
      }
    })
    console.log(
      { healthPort: this.config.health.port },
      'health server started',
    )
  }

  /**
   * Initialize the cursor manager for tracking actor sync cursors
   *
   * @param db - The database instance to use for cursor persistence
   */
  private async initCursorManager(db: Database): Promise<void> {
    this.cursorManager = new CursorManager(
      this.config.worker.cursorFlushIntervalMs,
      async (state) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        const rawDb = (db as any).db as Kysely<StratosIndexerSchema>

        if (state.stratosCursors.size > 0) {
          const now = new Date().toISOString()
          const values: NewStratosSyncCursor[] = Array.from(
            state.stratosCursors,
            ([did, seq]) => ({
              did,
              seq,
              updatedAt: now,
            }),
          )

          // Batch upsert all actor cursors in a single statement
          await rawDb
            .insertInto('stratos_sync_cursor')
            .values(values)
            .onConflict((oc) =>
              oc.column('did').doUpdateSet({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
                seq: (eb: any) => eb.ref('excluded.seq'),
                updatedAt: now,
              }),
            )
            .execute()
        }

        console.log(
          { pdsSeq: state.pdsSeq, actorCursors: state.stratosCursors.size },
          'cursor flush',
        )
      },
    )

    // Restore cursors from database (retry until migrations have run)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const rawDb = (db as any).db as Kysely<StratosIndexerSchema>
    const maxRetries = 30
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const savedCursors = await rawDb
          .selectFrom('stratos_sync_cursor')
          .select(['did', 'seq'])
          .execute()
        if (savedCursors.length > 0) {
          const cursorMap = new Map<string, number>()
          for (const row of savedCursors) {
            cursorMap.set(row.did, row.seq)
          }
          this.cursorManager.restore({ pdsSeq: 0, stratosCursors: cursorMap })
          console.log(
            { count: savedCursors.length },
            'restored sync cursors from database',
          )
        }
        break
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt === maxRetries) {
          throw new Error(
            `stratos_sync_cursor table not available after ${maxRetries} attempts: ${msg}`,
            { cause: err },
          )
        }
        console.log(
          { attempt, maxRetries, err: msg },
          'waiting for stratos_sync_cursor table (migrations may be pending)',
        )
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    this.cursorManager.start()
  }

  /**
   * Create the enrollment callback for indexing service
   * @param indexingService - The indexing service instance
   * @param background - The background task queue
   * @returns Callback functions for enrollment events
   * @private
   */
  private createEnrollmentCallback(
    indexingService: ReturnType<
      typeof createIndexingService
    >['indexingService'],
    background: ReturnType<typeof createIndexingService>['background'],
  ): EnrollmentCallback {
    return {
      onEnrollmentDiscovered: (
        did: string,
        _serviceUrl: string,
        boundaries: string[],
      ) => {
        if (this.enrolledDids.has(did)) return
        this.enrolledDids.add(did)
        console.log(
          { did, boundaries },
          'enrollment discovered, starting actor sync',
        )
        background.add(() => {
          void indexingService.indexHandle(did, new Date().toISOString())
        })
        this.syncManager?.addActor(did)
      },
      onEnrollmentRemoved: (did: string) => {
        this.enrolledDids.delete(did)
        console.log({ did }, 'enrollment removed, stopping actor sync')
        this.syncManager?.removeActor(did)
      },
    }
  }

  /**
   * Initialize the background task queue for running backfills
   * @param indexingService - The indexing service instance
   * @param background - The background task queue
   * @param backfillOpts - Options for backfilling
   * @private
   */
  private async runAllBackfills(
    indexingService: ReturnType<
      typeof createIndexingService
    >['indexingService'],
    background: ReturnType<typeof createIndexingService>['background'],
    backfillOpts: BackfillOptions,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const rawDb = (this.db as any).db as Kysely<StratosIndexerSchema>

    // Backfill existing repos
    console.log(
      {
        enrolledOnly: this.config.pds.enrolledOnly,
      },
      'starting repo backfill',
    )

    if (this.config.pds.enrolledOnly) {
      const enrolledFromDb = await rawDb
        .selectFrom('stratos_enrollment')
        .select(['did'])
        .execute()

      const didsToBackfill = new Set<string>(this.enrolledDids)
      for (const row of enrolledFromDb) {
        didsToBackfill.add(row.did)
      }

      const didsList = Array.from(didsToBackfill)

      // Start actor sync subscriptions for all enrolled actors so new
      // stratos records are indexed in real-time, independent of
      // the PDS firehose backlog position.
      for (const did of didsList) {
        this.enrolledDids.add(did)
        this.syncManager?.addActor(did)
        background.add(() => {
          void indexingService.indexHandle(did, new Date().toISOString())
        })
      }

      console.log(
        {
          fromDb: enrolledFromDb.length,
          fromSubscription: this.enrolledDids.size,
          total: didsList.length,
        },
        'enrolled-only backfill targets',
      )

      const backfilled = await backfillActors(backfillOpts, didsList)
      const now = Date.now()
      for (const did of didsList) {
        this.backfilledDids.set(did, now)
      }

      console.log(
        { count: backfilled, enrolledActors: this.enrolledDids.size },
        'enrolled-only backfill complete',
      )
    } else {
      const backfilled = await backfillRepos(backfillOpts)
      console.log(
        { count: backfilled, enrolledActors: this.enrolledDids.size },
        'backfill complete',
      )
    }
  }

  /**
   * Start logging memory and sync stats to the console
   * @private
   */
  private startStatsLogging(): void {
    setInterval(() => {
      const mem = Deno.memoryUsage()
      const syncStats = this.syncManager?.getStats()
      console.log(
        {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
          enrolledDids: this.enrolledDids.size,
          backfilledDids: this.backfilledDids.size,
          workerPending: this.pdsSubscriber?.stats.pendingCount ?? 0,
          workerActive: this.pdsSubscriber?.stats.runningCount ?? 0,
          activeConnections: syncStats?.activeConnections ?? 0,
          waitingActors: syncStats?.waitingActors ?? 0,
        },
        'memory stats (MB)',
      )
    }, 30_000)
  }

  /**
   * Backfill a single actor
   * @param did - The DID of the actor to backfill
   * @param opts - Options for the backfill operation
   * @private
   */
  private backfillReferencedActor(
    did: string,
    opts: Parameters<typeof backfillSingleActor>[0],
  ) {
    if (this.backfilledDids.has(did)) return
    this.backfilledDids.set(did, Date.now())
    console.log({ did }, 'backfilling referenced actor')
    void this.runBackfill(did, opts)
  }

  /**
   * Run backfill for a single actor
   *
   * @param did - The DID of the actor to backfill
   * @param opts - Options for the backfill operation
   */
  private async runBackfill(
    did: string,
    opts: Parameters<typeof backfillSingleActor>[0],
  ): Promise<void> {
    while (this.activeBackfills >= this.maxConcurrentBackfills) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
    this.activeBackfills++
    try {
      await backfillSingleActor(opts, did)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        { did, err: message },
        'failed to backfill referenced actor',
      )
    } finally {
      this.activeBackfills--
    }
  }
}
