import type { IndexerConfig } from './config.ts'
import {
  createDatabase,
  createIdResolver,
  createIndexingService,
} from './db.ts'
import { PdsSubscription } from './pds-subscription.ts'
import { StratosServiceSubscription, StratosActorSync } from './stratos-sync.ts'
import { backfillRepos } from './backfill.ts'
import type { Database } from '@atproto/bsky'

export class Indexer {
  private db: Database | null = null
  private pdsSubscription: PdsSubscription | null = null
  private stratosServiceSub: StratosServiceSubscription | null = null
  private stratosActorSync: StratosActorSync | null = null
  private healthServer: Deno.HttpServer | null = null
  private enrolledDids = new Set<string>()

  constructor(private config: IndexerConfig) {}

  async start(): Promise<void> {
    console.log('starting appview indexer')


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
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    )
    console.log({ healthPort: this.config.health.port }, 'health server started')

    const db = createDatabase(this.config.db)
    this.db = db

    const idResolver = createIdResolver(this.config.identity)
    const { indexingService, background } = createIndexingService(
      db,
      idResolver,
    )

    const syncConfig = {
      stratosServiceUrl: this.config.stratos.serviceUrl,
      syncToken: this.config.stratos.syncToken,
    }

    // Per-actor Stratos sync
    this.stratosActorSync = new StratosActorSync(
      (db as unknown as { db: unknown }).db as never,
      syncConfig,
      (err) => console.error({ err: err.message }, 'stratos actor sync error'),
    )
    this.stratosActorSync.start()

    // Enrollment callbacks — shared between PDS firehose and Stratos service stream
    const enrollmentCallback = {
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

    // Backfill existing repos (discovers enrollments during processing)
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

    // PDS firehose (continues discovering enrollments live)
    this.pdsSubscription = new PdsSubscription({
      service: this.config.pds.repoProvider,
      indexingService,
      background,
      enrollmentCallback,
      onError: (err) =>
        console.error({ err: err.message }, 'pds firehose error'),
    })
    this.pdsSubscription.start()
    console.log('PDS firehose connected')

    console.log(
      {
        healthPort: this.config.health.port,
        enrolledActors: this.enrolledDids.size,
      },
      'appview indexer started',
    )
  }

  async stop(): Promise<void> {
    console.log('stopping appview indexer')

    this.pdsSubscription?.stop()
    this.stratosServiceSub?.stop()
    this.stratosActorSync?.stop()
    this.healthServer?.shutdown()

    if (this.db) {
      await this.db.close()
    }

    console.log('appview indexer stopped')
  }
}
