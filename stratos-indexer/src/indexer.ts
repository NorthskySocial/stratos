import type { IndexerConfig } from './config.ts'
import type { Database } from '@atproto/bsky'
import type { Kysely } from '@atproto/bsky/dist/data-plane/server/db/types'
import type { DatabaseSchemaType } from '@atproto/bsky/dist/data-plane/server/db/database-schema'
import {
  createDatabase,
  createIdResolver,
  createIndexingService,
} from './db.ts'
import { WorkerPool } from './worker-pool.ts'
import { HandleDedup } from './handle-dedup.ts'
import { CursorManager } from './cursor-manager.ts'
import {
  PdsFirehose,
  processFirehoseWork,
  type EnrollmentCallback,
} from './pds-firehose.ts'
import { StratosServiceSubscription, StratosActorSync } from './stratos-sync.ts'
import {
  backfillRepos,
  backfillActors,
  backfillSingleActor,
} from './backfill.ts'

export class Indexer {
  private db: Database | null = null
  private pdsFirehose: PdsFirehose | null = null
  private stratosServiceSub: StratosServiceSubscription | null = null
  private stratosActorSync: StratosActorSync | null = null
  private workerPool: WorkerPool<unknown> | null = null
  private cursorManager: CursorManager | null = null
  private handleDedup: HandleDedup | null = null
  private healthServer: Deno.HttpServer | null = null
  private enrolledDids = new Set<string>()
  private backfilledDids = new Set<string>()
  private activeBackfills = 0
  private readonly maxConcurrentBackfills = 2

  constructor(private config: IndexerConfig) {}

  async start(): Promise<void> {
    console.log('starting stratos indexer')

    // Health server
    this.healthServer = Deno.serve(
      { port: this.config.health.port },
      (req: Request) => {
        if (new URL(req.url).pathname === '/health') {
          const mem = Deno.memoryUsage()
          const actorSyncStats = this.stratosActorSync?.getStats()
          return new Response(
            JSON.stringify({
              ok: true,
              enrolledActors: this.enrolledDids.size,
              activeActorSyncs:
                this.stratosActorSync?.getActiveActors().length ?? 0,
              workerPoolPending: this.workerPool?.pendingCount ?? 0,
              workerPoolActive: this.workerPool?.runningCount ?? 0,
              actorSync: actorSyncStats ?? null,
              memory: {
                rss: mem.rss,
                heapTotal: mem.heapTotal,
                heapUsed: mem.heapUsed,
                external: mem.external,
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    )
    console.log(
      { healthPort: this.config.health.port },
      'health server started',
    )

    // Database
    const db = createDatabase(this.config.db)
    this.db = db

    const idResolver = createIdResolver(this.config.identity)
    const { indexingService, background } = createIndexingService(
      db,
      idResolver,
      this.config,
    )

    // Cursor manager with periodic flush to database
    this.cursorManager = new CursorManager(
      this.config.worker.cursorFlushIntervalMs,
      async (state) => {
        const rawDb = (db as unknown as { db: unknown })
          .db as Kysely<DatabaseSchemaType>

        if (state.stratosCursors.size > 0) {
          const now = new Date().toISOString()
          const values = Array.from(state.stratosCursors, ([did, seq]) => ({
            did,
            seq,
            updatedAt: now,
          }))

          // Batch upsert all actor cursors in a single statement
          await rawDb
            .insertInto('stratos_sync_cursor' as never)
            .values(values as never)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .onConflict((oc: any) =>
              oc.column('did' as never).doUpdateSet({
                seq: (eb: unknown) =>
                  (eb as { ref: (col: string) => unknown }).ref(
                    'excluded.seq' as never,
                  ),
                updatedAt: now,
              } as never),
            )
            .execute()
        }

        console.log(
          { pdsSeq: state.pdsSeq, actorCursors: state.stratosCursors.size },
          'cursor flush',
        )
      },
    )

    // Restore cursors from database
    const rawDb = (db as unknown as { db: unknown })
      .db as Kysely<DatabaseSchemaType>
    const savedCursors = (await rawDb
      .selectFrom('stratos_sync_cursor' as never)
      .select(['did' as never, 'seq' as never])
      .execute()) as Array<{ did: string; seq: number }>
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

    this.cursorManager.start()

    // Handle dedup — skip redundant indexHandle calls for recently-seen DIDs
    const handleDedup = new HandleDedup()
    this.handleDedup = handleDedup

    // Enrollment callbacks (defined first, referenced by worker pool and subscriptions)
    const enrollmentCallback: EnrollmentCallback = {
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
        background.add(() =>
          indexingService.indexHandle(did, new Date().toISOString()),
        )
        void this.stratosActorSync?.addActor(did)
      },
      onEnrollmentRemoved: (did: string) => {
        this.enrolledDids.delete(did)
        console.log({ did }, 'enrollment removed, stopping actor sync')
        this.stratosActorSync?.removeActor(did)
      },
    }

    // Worker pool for PDS firehose processing
    const workerPool = new WorkerPool(
      this.config.worker.concurrency,
      this.config.worker.maxQueueSize,
      async (work: unknown) => {
        await processFirehoseWork(
          work as Parameters<typeof processFirehoseWork>[0],
          indexingService,
          background,
          enrollmentCallback,
          handleDedup,
        )
      },
      (err) => console.error({ err: err.message }, 'worker pool error'),
    )
    this.workerPool = workerPool as WorkerPool<unknown>

    const syncConfig = {
      stratosServiceUrl: this.config.stratos.serviceUrl,
      syncToken: this.config.stratos.syncToken,
    }

    const backfillOpts = {
      repoProvider: this.config.pds.repoProvider,
      indexingService,
      enrollmentCallback,
      onError: (err: Error) =>
        console.error({ err: err.message }, 'backfill error'),
      onProgress: (processed: number) => {
        if (processed % 100 === 0) {
          console.log({ processed }, 'backfill progress')
        }
      },
    }

    // Per-actor Stratos sync
    this.stratosActorSync = new StratosActorSync(
      (db as unknown as { db: unknown }).db as never,
      syncConfig,
      this.cursorManager,
      (err) => console.error({ err: err.message }, 'stratos actor sync error'),
      this.config.pds.enrolledOnly
        ? (did) => this.backfillReferencedActor(did, backfillOpts)
        : undefined,
      {
        maxConcurrentActorSyncs: this.config.worker.actorSyncConcurrency,
        maxActorQueueSize: this.config.worker.actorSyncQueuePerActor,
        globalMaxPending: this.config.worker.actorSyncGlobalMaxPending,
        drainDelayMs: this.config.worker.actorSyncDrainDelayMs,
      },
      (did) =>
        background.add(() =>
          indexingService.indexHandle(did, new Date().toISOString()),
        ),
    )
    this.stratosActorSync.start()

    // Stratos service-level enrollment stream
    this.stratosServiceSub = new StratosServiceSubscription(
      syncConfig,
      {
        onEnroll: (did, boundaries) => {
          enrollmentCallback.onEnrollmentDiscovered(
            did,
            this.config.stratos.serviceUrl,
            boundaries,
          )
        },
        onUnenroll: (did) => {
          enrollmentCallback.onEnrollmentRemoved(did)
        },
      },
      (err) => console.error({ err: err.message }, err.message),
    )
    await this.stratosServiceSub.start()
    console.log('stratos service-level enrollment stream connected')

    // Backfill existing repos
    console.log(
      {
        enrolledOnly: this.config.pds.enrolledOnly,
      },
      'starting repo backfill',
    )

    if (this.config.pds.enrolledOnly) {
      const enrolledFromDb = (await rawDb
        .selectFrom('stratos_enrollment' as never)
        .select(['did' as never])
        .execute()) as Array<{ did: string }>

      const didsToBackfill = new Set<string>(this.enrolledDids)
      for (const row of enrolledFromDb) {
        didsToBackfill.add(row.did)
      }

      const didsList = Array.from(didsToBackfill)
      this.stratosActorSync.markKnown(didsToBackfill)

      // Start actor sync subscriptions for all enrolled actors so new
      // stratos records are indexed in real-time, independent of
      // the PDS firehose backlog position.
      for (const did of didsList) {
        this.enrolledDids.add(did)
        this.stratosActorSync.addActor(did)
        background.add(() =>
          indexingService.indexHandle(did, new Date().toISOString()),
        )
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
      for (const did of didsList) {
        this.backfilledDids.add(did)
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

    // PDS firehose via @atcute/firehose
    this.pdsFirehose = new PdsFirehose({
      repoProvider: this.config.pds.repoProvider,
      indexingService,
      background,
      workerPool: workerPool as never,
      cursorManager: this.cursorManager,
      enrollmentCallback,
      handleDedup,
      onError: (err) =>
        console.error({ err: err.message }, 'pds firehose error'),
    })
    this.pdsFirehose.start()
    console.log('PDS firehose connected')

    console.log(
      {
        healthPort: this.config.health.port,
        enrolledActors: this.enrolledDids.size,
        workerConcurrency: this.config.worker.concurrency,
        maxQueueSize: this.config.worker.maxQueueSize,
        actorSyncConcurrency: this.config.worker.actorSyncConcurrency,
        actorSyncQueuePerActor: this.config.worker.actorSyncQueuePerActor,
      },
      'stratos indexer started',
    )
  }

  private backfillReferencedActor(
    did: string,
    opts: Parameters<typeof backfillSingleActor>[0],
  ): void {
    if (this.backfilledDids.has(did)) return
    this.backfilledDids.add(did)
    console.log({ did }, 'backfilling referenced actor')
    void this.runBackfill(did, opts)
  }

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

  async stop(): Promise<void> {
    console.log('stopping stratos indexer')

    this.pdsFirehose?.stop()
    this.stratosServiceSub?.stop()
    this.stratosActorSync?.stop()
    this.handleDedup?.stop()

    if (this.workerPool) {
      await this.workerPool.stop()
    }

    if (this.cursorManager) {
      await this.cursorManager.stop()
    }

    this.healthServer?.shutdown()

    if (this.db) {
      await this.db.close()
    }

    console.log('stratos indexer stopped')
  }
}
