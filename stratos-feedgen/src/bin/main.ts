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
import { SpaceMutationFence } from '../mutation-fence.js'
import { FeedReadinessGate } from '../readiness.js'
import { createFeedgenServer } from '../server.js'
import { SpaceCredentialManager } from '../space-credential/index.js'
import {
  CommitVerifier,
  createCommitKeyResolver,
  getRepoOpsResponseByteLimit,
  MembershipTracker,
  SpaceHostClient,
  SpaceSyncer,
  SpaceSyncRunner,
  SpaceSyncScheduler,
} from '../space-sync/index.js'
import {
  ActorPool,
  CurrentMembershipReplayAuthorizer,
  intersectsBoundaries,
  ServiceStream,
  SubscriptionIndexer,
} from '../subscription/index.js'
import {
  describeUpstreamError,
  UpstreamStratosClient,
} from '../upstream/index.js'

const MAX_WARM_UP_FAILURES = 10
const MAX_WARM_UP_FIELD_LENGTH = 200

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
  const commitKeyResolver = createCommitKeyResolver(idResolver.did)

  const upstream = new UpstreamStratosClient({
    serviceUrl: cfg.stratosServiceUrl,
    publicUrl: cfg.stratosPublicUrl,
    serviceDid: cfg.stratosServiceDid,
    feedgenDid: cfg.feedgenServiceDid,
    keypair,
    requestTimeoutMs: cfg.spaceMembershipRequestTimeoutMs,
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

  const spaceCredentialManager = new SpaceCredentialManager({
    client: upstream,
    signingKey: keypair,
    feedgenDid: cfg.feedgenServiceDid,
    authorityDid: cfg.stratosServiceDid,
  })

  const store = await createFeedgenStore(cfg)
  shutdownDeps.store = store
  const spaceMutationFence = new SpaceMutationFence()
  // Never serve the local projection until the enrollment stream has opened
  // and a complete current-authority reconciliation has finished.
  const feedReadiness = new FeedReadinessGate()

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
    feedReadiness,
  })

  const httpServer = await server.listen(port)
  shutdownDeps.httpServer = httpServer
  logger.info({ port }, 'stratos-feedgen listening')

  const configuredBoundaries = new Set(feeds.list().map((f) => f.boundary))
  const replayAuthorizer = new CurrentMembershipReplayAuthorizer({
    client: upstream,
    configuredBoundaries,
  })
  const indexer = new SubscriptionIndexer(store, {
    onPostIndexed: () => metrics.indexPostsTotal.inc(),
    replayAuthorizer,
  })

  // Best-effort warm-up: a boundary this feedgen has no membership for yet
  // (or a mint failure) must not block startup or crash the process. The sync
  // path still acquires credentials on demand; this only reduces first-pass
  // mint latency. Emit one completion event, not one line per boundary.
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
    const context = {
      attempted: results.length,
      acquired: results.length - failed.length,
      failed: failed.length,
      failures: failed.slice(0, MAX_WARM_UP_FAILURES).map((failure) => ({
        boundary: boundWarmUpField(failure.boundary),
        reason: boundWarmUpField(failure.reason),
      })),
      omittedFailures: Math.max(0, failed.length - MAX_WARM_UP_FAILURES),
    }
    if (failed.length === 0) {
      logger.info(context, 'space credential warm-up completed')
    } else {
      logger.warn(context, 'space credential warm-up completed with failures')
    }
  })

  const subscribeEnrollments =
    process.env['FEEDGEN_SUBSCRIBE_ENROLLMENTS'] !== 'false'
  let subscription: {
    serviceStream: ServiceStream
    actorPool: ActorPool
    purger: Purger
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
      spaceMutationFence,
      feedReadiness,
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

  if (cfg.spaceSyncEnabled) {
    const purger =
      subscription?.purger ??
      new Purger({
        store,
        mutationFence: spaceMutationFence,
        enrollmentCache: enrollmentManager,
        audit: (entry) => logger.info({ ...entry }, 'feedgen purge'),
      })
    const membership = new MembershipTracker({
      client: upstream,
      credentialManager: spaceCredentialManager,
      purger,
      snapshotStore: store,
      mutationFence: spaceMutationFence,
      pageLimit: cfg.spaceMembershipPageLimit,
      log: (event) =>
        logger.info({ ...event }, 'space membership pass completed'),
      onError: (boundary, err) =>
        logger.error({ boundary, err }, 'space membership pass failed'),
    })
    const syncer = new SpaceSyncer({
      store,
      credentialManager: spaceCredentialManager,
      mutationFence: spaceMutationFence,
      createHostClient: (options) =>
        new SpaceHostClient({
          ...options,
          requestTimeoutMs: cfg.spaceSyncRequestTimeoutMs,
          allowHttpOrigins: cfg.spaceSyncAllowHttpOrigins,
          maxPageBytes: getRepoOpsResponseByteLimit(
            cfg.spaceSyncPageLimit,
            cfg.spaceSyncMaxRecordBytes,
          ),
          maxRecordBytes: cfg.spaceSyncMaxRecordBytes,
        }),
      maxRecordBytes: cfg.spaceSyncMaxRecordBytes,
      maxPages: cfg.spaceSyncMaxPages,
      maxRecordsPerMember: cfg.spaceSyncMaxRecordsPerMember,
      pageLimit: cfg.spaceSyncPageLimit,
      onError: (target, err) =>
        logger.error({ target, err }, 'space member sync failed'),
    })
    const runner = new SpaceSyncRunner({
      syncer,
      verifier: new CommitVerifier({ didResolver: commitKeyResolver }),
      purger,
      mutationFence: spaceMutationFence,
      onVerifyFailure: (event) =>
        logger.error({ ...event }, 'space commit verification failed'),
      onVerifyTransient: (event, err) =>
        logger.warn({ ...event, err }, 'space commit verification deferred'),
      onConsecutiveFailure: (event) =>
        logger.warn(
          { ...event },
          'space commit verification failed on consecutive passes',
        ),
      onError: (target, err) =>
        logger.error({ target, err }, 'space sync runner failed'),
    })
    const scheduler = new SpaceSyncScheduler({
      membership,
      runner,
      boundaries: configuredBoundaries,
      intervalMs: cfg.spaceSyncIntervalMs,
      memberBudgetMs: cfg.spaceSyncMemberBudgetMs,
      memberConcurrency: cfg.spaceSyncMemberConcurrency,
      log: (event) => {
        const context = { ...event }
        if (
          event.skippedOversized > 0 ||
          event.skippedMalformed > 0 ||
          event.maxPageStops > 0 ||
          event.capped > 0
        ) {
          logger.warn(context, 'space sync pass completed with limits')
        } else {
          logger.info(context, 'space sync pass completed')
        }
      },
      onTickSkipped: () =>
        logger.warn({}, 'space sync tick skipped because a pass is active'),
      onMemberBudgetExceeded: (target) =>
        logger.warn({ target }, 'space member exceeded the sync budget'),
      onError: (err) => logger.error({ err }, 'space sync pass failed'),
    })
    shutdownDeps.spaceSyncScheduler = scheduler
    scheduler.start()
    logger.info({}, 'space sync scheduler started')
  }
}

function boundWarmUpField(value: string): string {
  return value.slice(0, MAX_WARM_UP_FIELD_LENGTH)
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
  spaceMutationFence: SpaceMutationFence
  feedReadiness: FeedReadinessGate
}

/**
 * Wire the enrollment subscription: seed the actor pool, run startup
 * reconciliation (purging anything that left scope while down), then attach the
 * live enroll/unenroll consumer that drives the deletion pathway.
 */
async function startSubscription(deps: StartSubscriptionDeps): Promise<{
  serviceStream: ServiceStream
  actorPool: ActorPool
  purger: Purger
}> {
  const { cfg, upstream, store, indexer, enrollmentManager, logger, metrics } =
    deps
  const { configuredBoundaries, spaceMutationFence, feedReadiness } = deps

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
    mutationFence: spaceMutationFence,
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
    const generation = feedReadiness.beginReconciliation()
    const summary = await reconcileEnrollments(
      {
        store,
        purger,
        mutationFence: spaceMutationFence,
        actorPool: pool,
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
    const released = feedReadiness.completeReconciliation(generation, summary)
    if (!released && (summary.errors > 0 || summary.truncated)) {
      logger.warn(
        { ...summary },
        'feed remains unavailable until enrollment reconciliation is complete',
      )
    }
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
    spaceMutationFence.beginDidMutation(did)
    try {
      await spaceMutationFence.withDidScope(did, async (scope) => {
        const now = new Date().toISOString()
        const existing = await store.getEnrolledActor(did)
        if (existing) {
          const nextSet = new Set(boundaries)
          const lost = existing.boundaries.filter(
            (b) => configuredBoundaries.has(b) && !nextSet.has(b),
          )
          if (lost.length > 0) {
            await pool.removeActorAndDrain(did)
          }
          for (const boundary of lost) {
            await purger.purgeActorBoundaryWithinScope(scope, boundary)
          }
        }
        await store.upsertEnrolledActor({
          did,
          boundaries,
          enrolledAt: existing?.enrolledAt ?? now,
          lastSeenAt: now,
        })
        // The boundary cache may hold a stale set for this viewer. The purge
        // already invalidates on shrink; invalidate here too for a pure grow.
        enrollmentManager.invalidate(did)
        if (intersectsBoundaries(boundaries, configuredBoundaries)) {
          pool.addActor(did)
        } else {
          pool.removeActor(did)
        }
      })
    } finally {
      spaceMutationFence.endDidMutation(did)
    }
  }

  const serviceStream = new ServiceStream(
    {
      stratosServiceUrl: cfg.stratosServiceUrl,
      mintToken: () => upstream.mintServiceAuthToken(),
      onReconnectScheduled: () => {
        feedReadiness.markUnavailable()
        metrics.reconnectsTotal.inc({ kind: 'service' })
      },
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
        spaceMutationFence.beginDidMutation(did)
        try {
          await purger.purgeActor(did)
        } finally {
          spaceMutationFence.endDidMutation(did)
        }
      },
      // Every open triggers a reconcile: a reconnect can hide a missed
      // unenroll, and the startup reconcile can itself run against a
      // degraded upstream (per-actor resolve failures are only counted).
      // The scheduler coalesces, so a healthy boot pays one bounded extra
      // run.
      onSessionEstablished: () => {
        feedReadiness.markSessionEstablished()
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

  return { serviceStream, actorPool: pool, purger }
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
