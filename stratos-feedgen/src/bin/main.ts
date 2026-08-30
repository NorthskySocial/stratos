#!/usr/bin/env node
import { Secp256k1Keypair } from '@atproto/crypto'
import type { Logger } from '@northskysocial/stratos-core'
import { createFeedRequestVerifier, createIdResolver } from '../auth/index.js'
import { type FeedgenConfig, loadFeedgenConfig } from '../config.js'
import { createFeedgenStore, type FeedgenStore } from '../db/index.js'
import { EnrollmentManager } from '../enrollment/index.js'
import { loadFeedRegistry } from '../feeds/index.js'
import {
  createShutdownHandler,
  installPanicHandlers,
  type ShutdownDeps,
} from '../lifecycle/shutdown.js'
import { createLogger } from '../logger.js'
import {
  createFeedgenMetrics,
  type FeedgenMetrics,
  type SubscriptionStatus,
} from '../metrics.js'
import {
  createReconcileScheduler,
  Purger,
  reconcileEnrollments,
} from '../purge/index.js'
import { createFeedgenServer } from '../server.js'
import { SpaceCredentialManager } from '../space-credential/index.js'
import {
  ActorPool,
  intersectsBoundaries,
  ServiceStream,
  SubscriptionIndexer,
} from '../subscription/index.js'
import {
  describeUpstreamError,
  UpstreamStratosClient,
} from '../upstream/index.js'

async function main(): Promise<void> {
  const cfg = loadFeedgenConfig()
  const logger = createLogger(cfg.logLevel)
  installPanicHandlers(logger)

  // Listeners are installed before the long async startup. The handler reads
  // the deps at signal time, and startup fills them as resources come up, so
  // a mid-startup signal drains exactly what already exists (open store,
  // listening server) instead of exiting around it.
  const shutdownDeps: ShutdownDeps = { logger }
  const shutdown = createShutdownHandler(shutdownDeps)
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  const feeds = loadFeedRegistry()
  const port = parsePort(process.env['FEEDGEN_PORT']) ?? 3000

  const keypair = await Secp256k1Keypair.import(cfg.feedgenSigningKey)
  const publicKeyMultibase = keypair.did().slice('did:key:'.length)
  const idResolver = createIdResolver(cfg)

  const upstream = new UpstreamStratosClient({
    serviceUrl: cfg.stratosServiceUrl,
    publicUrl: cfg.stratosPublicUrl,
    serviceDid: cfg.stratosServiceDid,
    feedgenDid: cfg.feedgenServiceDid,
    keypair,
  })

  const subscriptionStatus: SubscriptionStatus = {
    serviceStream: null,
    actorPool: null,
  }
  const metrics = createFeedgenMetrics(subscriptionStatus)

  const enrollmentManager = new EnrollmentManager({
    client: upstream,
    ttlMs: cfg.boundaryCacheTtlMs,
    max: cfg.boundaryCacheMax,
    onCacheEvent: (event) => {
      if (event === 'hit') metrics.boundaryCacheHits.inc()
      else metrics.boundaryCacheMisses.inc()
    },
  })

  // Held for the syncer this feedgen becomes in MM-06; not yet on the sync
  // path. Constructing it here so credential acquisition is exercised at
  // startup rather than the first time something needs it.
  const spaceCredentialManager = new SpaceCredentialManager({
    client: upstream,
    signingKey: keypair,
    feedgenDid: cfg.feedgenServiceDid,
    authorityDid: cfg.stratosServiceDid,
  })

  const store = await createFeedgenStore(cfg)
  shutdownDeps.store = store

  const verifier = createFeedRequestVerifier({
    feedgenDid: cfg.feedgenServiceDid,
    allowedLxms: cfg.feedgenAllowedLxms,
    idResolver,
  })

  const server = createFeedgenServer({
    feedgenServiceDid: cfg.feedgenServiceDid,
    feedgenPublicUrl: cfg.feedgenPublicUrl,
    publicKeyMultibase,
    feeds,
    store,
    enrollmentManager,
    verifier,
    logger,
    metrics,
    metricsToken: cfg.metricsToken,
    subscriptionStatus,
  })

  const httpServer = await server.listen(port)
  shutdownDeps.httpServer = httpServer
  logger.info({ port }, 'stratos-feedgen listening')

  const configuredBoundaries = new Set(feeds.list().map((f) => f.boundary))
  const indexer = new SubscriptionIndexer(store, {
    onPostIndexed: () => metrics.indexPostsTotal.inc(),
  })

  // Best-effort warm-up: a boundary this feedgen has no membership for yet
  // (or a mint failure) must not block startup or crash the process. MM-06
  // will make actual sync depend on a held credential; here we only prove
  // acquisition works. Emit one completion event, not one line per boundary.
  // Log the acquired count too. A summary with only failures makes a warm-up
  // that never ran look the same as one that worked.
  void Promise.all(
    [...configuredBoundaries].map(async (boundary) => {
      try {
        await spaceCredentialManager.getCredential(boundary)
        return { boundary }
      } catch (err: unknown) {
        return { boundary, reason: describeUpstreamError(err) }
      }
    }),
  ).then((results) => {
    const failed = results.filter(
      (r): r is { boundary: string; reason: string } => 'reason' in r,
    )
    const summary = `space credential warm-up: attempted=${results.length} acquired=${results.length - failed.length} failed=${failed.length}`
    if (failed.length === 0) {
      console.log(summary)
    } else {
      const detail = failed.map((f) => `${f.boundary}: ${f.reason}`).join('; ')
      console.error(`${summary} (${detail})`)
    }
  })

  const subscribeEnrollments =
    process.env['FEEDGEN_SUBSCRIBE_ENROLLMENTS'] !== 'false'
  let subscription: {
    serviceStream: ServiceStream
    actorPool: ActorPool
  } | null = null
  if (subscribeEnrollments) {
    const starting = startSubscription({
      cfg,
      upstream,
      store,
      indexer,
      enrollmentManager,
      configuredBoundaries,
      logger,
      metrics,
      shutdownDeps,
    })
    // Shutdown awaits this barrier before it closes the store. The swallow
    // keeps a startup failure out of the panic path; main's catch reports it.
    shutdownDeps.startup = starting.then(
      () => undefined,
      () => undefined,
    )
    subscription = await starting
  }
  subscriptionStatus.serviceStream = subscription?.serviceStream ?? null
  subscriptionStatus.actorPool = subscription?.actorPool ?? null
}

interface StartSubscriptionDeps {
  cfg: FeedgenConfig
  upstream: UpstreamStratosClient
  store: FeedgenStore
  indexer: SubscriptionIndexer
  enrollmentManager: EnrollmentManager
  configuredBoundaries: Set<string>
  logger: Logger
  metrics: FeedgenMetrics
  shutdownDeps: ShutdownDeps
}

/**
 * Wire the enrollment subscription: seed the actor pool, run startup
 * reconciliation (purging anything that left scope while down), then attach the
 * live enroll/unenroll consumer that drives the deletion pathway.
 */
async function startSubscription(deps: StartSubscriptionDeps): Promise<{
  serviceStream: ServiceStream
  actorPool: ActorPool
}> {
  const { cfg, upstream, store, indexer, enrollmentManager, logger, metrics } =
    deps
  const { configuredBoundaries } = deps

  const pool = new ActorPool(
    {
      stratosServiceUrl: cfg.stratosServiceUrl,
      mintToken: () => upstream.mintServiceAuthToken(),
      maxConnections: parseIntEnv(
        process.env['FEEDGEN_ACTOR_SYNC_MAX_CONNECTIONS'],
      ),
      idleEvictionMs: parseIntEnv(
        process.env['FEEDGEN_ACTOR_SYNC_IDLE_EVICTION_MS'],
      ),
      onReconnectScheduled: () =>
        metrics.reconnectsTotal.inc({ kind: 'actor' }),
    },
    {
      store,
      indexer,
      onError: (err) => {
        logger.error({ err }, 'actor pool error')
      },
    },
  )
  // Publish before start, so a signal during seeding drains the pool.
  deps.shutdownDeps.actorPool = pool
  pool.start()

  const purger = new Purger({
    store,
    enrollmentCache: enrollmentManager,
    actorPool: pool,
    audit: (entry) => logger.info({ ...entry }, 'feedgen purge'),
  })

  // Reconciliation: catch enroll/unenroll (and boundary-shrink) changes
  // missed while the feedgen was down or disconnected by diffing the
  // persisted snapshot against a fresh resolveEnrollments snapshot. Bounded
  // via batching so upstream resolves don't fan out unbounded on large
  // tenants.
  const runReconcile = async (): Promise<void> => {
    await reconcileEnrollments(
      {
        store,
        purger,
        client: upstream,
        log: (summary) =>
          logger.info({ ...summary }, 'enrollment reconciliation completed'),
        onError: (did, err) =>
          logger.error({ did, err }, 'reconcile resolve failed'),
      },
      configuredBoundaries,
      {
        batchSize: parseIntEnv(process.env['FEEDGEN_RECONCILE_BATCH_SIZE']),
        maxActors: parseIntEnv(process.env['FEEDGEN_RECONCILE_MAX_ACTORS']),
      },
    )
  }
  await runReconcile()
  const triggerReconcile = createReconcileScheduler(runReconcile, (err) => {
    logger.error({ err }, 'reconnect reconciliation failed')
  })

  // Seed only AFTER reconciliation so the snapshot already reflects
  // revocations that landed while the feedgen was down - otherwise an actor
  // whose boundaries were revoked would enter the live pool from the stale
  // snapshot and keep syncing until the next restart.
  const seeded = await pool.seedFromStore(configuredBoundaries)
  logger.info({ seeded }, 'actor pool seeded')

  // Apply an actor's current boundary set: purge derived state for any
  // configured boundary the actor left, refresh the enrolled-actor snapshot,
  // evict the (now stale) cached viewer→boundaries entry so revocation is not
  // masked by the boundary cache, and re-evaluate live-syncer membership.
  // Shared by the `enroll` frame (which may carry a changed set) and the
  // dedicated `boundaries` change frame; idempotent either way.
  const applyBoundarySet = async (
    did: string,
    boundaries: string[],
  ): Promise<void> => {
    const now = new Date().toISOString()
    const existing = await store.getEnrolledActor(did)
    if (existing) {
      const nextSet = new Set(boundaries)
      const lost = existing.boundaries.filter(
        (b) => configuredBoundaries.has(b) && !nextSet.has(b),
      )
      for (const boundary of lost) {
        await purger.purgeActorBoundary(did, boundary)
      }
    }
    await store.upsertEnrolledActor({
      did,
      boundaries,
      enrolledAt: existing?.enrolledAt ?? now,
      lastSeenAt: now,
    })
    // The boundary cache may hold a stale set for this viewer. `purgeActorBoundary`
    // already invalidates when a boundary is lost; invalidate here too so a pure
    // grow (no lost boundary) still evicts the stale entry.
    enrollmentManager.invalidate(did)
    if (intersectsBoundaries(boundaries, configuredBoundaries)) {
      pool.addActor(did)
    } else {
      pool.removeActor(did)
    }
  }

  const serviceStream = new ServiceStream(
    {
      stratosServiceUrl: cfg.stratosServiceUrl,
      mintToken: () => upstream.mintServiceAuthToken(),
      onReconnectScheduled: () =>
        metrics.reconnectsTotal.inc({ kind: 'service' }),
    },
    {
      onEnroll: async (did, boundaries) => {
        await applyBoundarySet(did, boundaries)
      },
      // dedicated boundary-set-change frame. Drives the boundary-shrink
      // purge and event-driven cache eviction; without it no stream trigger
      // fires for an in-place boundary change.
      onBoundariesChanged: async (did, boundaries) => {
        await applyBoundarySet(did, boundaries)
      },
      onUnenroll: async (did) => {
        // purgeActor invalidates the boundary cache as part of the purge.
        await purger.purgeActor(did)
      },
      // Every open triggers a reconcile: a reconnect can hide a missed
      // unenroll, and the startup reconcile can itself run against a
      // degraded upstream (per-actor resolve failures are only counted).
      // The scheduler coalesces, so a healthy boot pays one bounded extra
      // run.
      onSessionEstablished: () => {
        triggerReconcile()
      },
    },
    (err) => {
      logger.error({ err }, 'service stream error')
    },
  )
  deps.shutdownDeps.serviceStream = serviceStream
  serviceStream.start()
  logger.info({}, 'service enrollment subscription started')

  return { serviceStream, actorPool: pool }
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid FEEDGEN_PORT: ${value}`)
  }
  return n
}

function parseIntEnv(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid integer env value: ${value}`)
  }
  return n
}

main().catch((err: unknown) => {
  // Config/startup can fail before the configured logger exists.
  createLogger('info').error({ err }, 'fatal startup error')
  process.exit(1)
})
