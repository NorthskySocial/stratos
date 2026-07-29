#!/usr/bin/env node
import { IdResolver } from '@atproto/identity'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createFeedRequestVerifier } from '../auth/index.js'
import { type FeedgenConfig, loadFeedgenConfig } from '../config.js'
import { createFeedgenStore, type FeedgenStore } from '../db/index.js'
import { EnrollmentManager } from '../enrollment/index.js'
import { loadFeedRegistry } from '../feeds/index.js'
import { Purger, reconcileEnrollments } from '../purge/index.js'
import { createFeedgenServer } from '../server.js'
import {
  ActorPool,
  intersectsBoundaries,
  ServiceStream,
  SubscriptionIndexer,
} from '../subscription/index.js'
import { UpstreamStratosClient } from '../upstream/index.js'

async function main(): Promise<void> {
  const cfg = loadFeedgenConfig()
  const feeds = loadFeedRegistry()
  const port = parsePort(process.env['FEEDGEN_PORT']) ?? 3000

  const keypair = await Secp256k1Keypair.import(cfg.feedgenSigningKey)
  const publicKeyMultibase = keypair.did().slice('did:key:'.length)
  const idResolver = new IdResolver({ plcUrl: cfg.feedgenPlcUrl })

  const upstream = new UpstreamStratosClient({
    serviceUrl: cfg.stratosServiceUrl,
    serviceDid: cfg.stratosServiceDid,
    feedgenDid: cfg.feedgenServiceDid,
    keypair,
  })

  const enrollmentManager = new EnrollmentManager({
    client: upstream,
    ttlMs: cfg.boundaryCacheTtlMs,
    max: cfg.boundaryCacheMax,
  })

  const store = await createFeedgenStore(cfg)

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
  })

  const httpServer = await server.listen(port)
  console.log(`stratos-feedgen listening on :${port}`)

  const configuredBoundaries = new Set(feeds.list().map((f) => f.boundary))
  const indexer = new SubscriptionIndexer(store)

  const subscribeEnrollments =
    process.env['FEEDGEN_SUBSCRIBE_ENROLLMENTS'] !== 'false'
  const subscription = subscribeEnrollments
    ? await startSubscription({
        cfg,
        upstream,
        store,
        indexer,
        enrollmentManager,
        configuredBoundaries,
      })
    : null
  const serviceStream = subscription?.serviceStream ?? null
  const actorPool = subscription?.actorPool ?? null

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`received ${signal}, shutting down`)
    serviceStream?.stop()
    const poolStop = actorPool ? actorPool.stop() : Promise.resolve()
    httpServer.close()
    poolStop
      .then(() => store.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error('error closing store', err)
          process.exit(1)
        },
      )
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

interface StartSubscriptionDeps {
  cfg: FeedgenConfig
  upstream: UpstreamStratosClient
  store: FeedgenStore
  indexer: SubscriptionIndexer
  enrollmentManager: EnrollmentManager
  configuredBoundaries: Set<string>
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
  const { cfg, upstream, store, indexer, enrollmentManager } = deps
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
    },
    {
      store,
      indexer,
      onError: (err) => {
        console.error('actor pool error:', err)
      },
    },
  )
  pool.start()

  const purger = new Purger({
    store,
    enrollmentCache: enrollmentManager,
    actorPool: pool,
  })

  // Startup reconciliation: catch enroll/unenroll (and boundary-shrink)
  // changes missed while the feedgen was down by diffing the persisted
  // snapshot against a fresh resolveEnrollments snapshot. Bounded via
  // batching so upstream resolves don't fan out unbounded on large tenants.
  const summary = await reconcileEnrollments(
    { store, purger, client: upstream },
    configuredBoundaries,
    {
      batchSize: parseIntEnv(process.env['FEEDGEN_RECONCILE_BATCH_SIZE']),
      maxActors: parseIntEnv(process.env['FEEDGEN_RECONCILE_MAX_ACTORS']),
    },
  )
  console.log(
    `enrollment reconciliation examined ${summary.examined} actors ` +
      `(${summary.unenrolled} unenrolled, ${summary.shrunk} shrunk, ` +
      `${summary.postsPurged} posts purged, ${summary.errors} errors)`,
  )

  // Seed only AFTER reconciliation so the snapshot already reflects
  // revocations that landed while the feedgen was down - otherwise an actor
  // whose boundaries were revoked would enter the live pool from the stale
  // snapshot and keep syncing until the next restart.
  const seeded = await pool.seedFromStore(configuredBoundaries)
  console.log(`actor pool seeded with ${seeded} actors`)

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
    },
    (err) => {
      console.error('service stream error:', err)
    },
  )
  serviceStream.start()
  console.log('service enrollment subscription started')

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
  console.error('fatal:', err)
  process.exit(1)
})
