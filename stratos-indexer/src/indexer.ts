import type { IndexerConfig } from './config.ts'
import type { Database } from '@atproto/bsky'
import {
  createDatabase,
  createIdResolver,
  createIndexingService,
} from './db.ts'
import { WorkerPool } from './worker-pool.ts'
import { CursorManager } from './cursor-manager.ts'
import {
  PdsFirehose,
  processFirehoseWork,
  type EnrollmentCallback,
} from './pds-firehose.ts'
import {
  StratosServiceSubscription,
  StratosActorSync,
} from './stratos-sync.ts'
import { backfillRepos } from './backfill.ts'

export class Indexer {
  private db: Database | null = null
  private pdsFirehose: PdsFirehose | null = null
  private stratosServiceSub: StratosServiceSubscription | null = null
  private stratosActorSync: StratosActorSync | null = null
  private workerPool: WorkerPool<unknown> | null = null
  private cursorManager: CursorManager | null = null
  private healthServer: Deno.HttpServer | null = null
  private enrolledDids = new Set<string>()

  constructor(private config: IndexerConfig) {}

  async start(): Promise<void> {
    console.log('starting stratos indexer')

    // Health server
    this.healthServer = Deno.serve(
      { port: this.config.health.port },
      (req: Request) => {
        if (new URL(req.url).pathname === '/health') {
          return new Response(
            JSON.stringify({
              ok: true,
              enrolledActors: this.enrolledDids.size,
              activeActorSyncs:
                this.stratosActorSync?.getActiveActors().length ?? 0,
              workerPoolPending: this.workerPool?.pendingCount ?? 0,
              workerPoolActive: this.workerPool?.runningCount ?? 0,
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    )
    console.log({ healthPort: this.config.health.port }, 'health server started')

    // Database
    const db = createDatabase(this.config.db)
    this.db = db

    const idResolver = createIdResolver(this.config.identity)
    const { indexingService, background } = createIndexingService(
      db,
      idResolver,
    )

    // Cursor manager with periodic flush
    this.cursorManager = new CursorManager(
      this.config.worker.cursorFlushIntervalMs,
      async (state) => {
        console.log(
          { pdsSeq: state.pdsSeq, actorCursors: state.stratosCursors.size },
          'cursor flush',
        )
      },
    )
    this.cursorManager.start()

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
        )
      },
      (err) => console.error({ err: err.message }, 'worker pool error'),
    )
    this.workerPool = workerPool as WorkerPool<unknown>

    const syncConfig = {
      stratosServiceUrl: this.config.stratos.serviceUrl,
      syncToken: this.config.stratos.syncToken,
    }

    // Per-actor Stratos sync
    this.stratosActorSync = new StratosActorSync(
      (db as unknown as { db: unknown }).db as never,
      syncConfig,
      this.cursorManager,
      (err) => console.error({ err: err.message }, 'stratos actor sync error'),
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
    console.log('starting repo backfill')
    const backfilled = await backfillRepos({
      repoProvider: this.config.pds.repoProvider,
      indexingService,
      enrollmentCallback,
      onError: (err) => console.error({ err: err.message }, 'backfill error'),
      onProgress: (processed, total) => {
        if (processed % 100 === 0 || processed === total) {
          console.log({ processed, total }, 'backfill progress')
        }
      },
    })
    console.log(
      { count: backfilled, enrolledActors: this.enrolledDids.size },
      'backfill complete',
    )

    // PDS firehose via @atcute/firehose
    this.pdsFirehose = new PdsFirehose({
      repoProvider: this.config.pds.repoProvider,
      indexingService,
      background,
      workerPool: workerPool as never,
      cursorManager: this.cursorManager,
      enrollmentCallback,
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
      },
      'stratos indexer started',
    )
  }

  async stop(): Promise<void> {
    console.log('stopping stratos indexer')

    this.pdsFirehose?.stop()
    this.stratosServiceSub?.stop()
    this.stratosActorSync?.stop()

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
