import path from 'node:path'
import * as fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import express from 'express'
import * as crypto from '@atproto/crypto'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { fileExists } from '@atproto/common'

import { sql } from 'drizzle-orm'
import {
  createAttestationPayload,
  DefaultLexiconProvider,
} from '@northskysocial/stratos-core'
import {
  initBlob,
  initEnrollment,
  initHydration,
  initMst,
  initRepo,
  MigratingBoundaryResolver,
  EnrollmentBoundaryResolver,
} from './features'

import { getServiceDidWithFragment } from './config.js'
import { createStorageContext } from './storage-context.js'
import { createIdResolver } from './identity-resolver.js'
import { createOAuthClientContext } from './oauth/client-factory.js'
import { DpopVerifier } from './infra/auth'
import {
  type OAuthSessionStoreBackend,
  type OAuthStateStoreBackend,
} from './oauth'
import {
  buildUserAgent,
  createFetchWithUserAgent,
} from './shared/user-agent.js'
import { VERSION } from './version.js'
import {
  type AppContext,
  type AppContextOptions,
  type EnrollmentEventEmitter,
  type SequenceEventEmitter,
  StorageContext,
} from './context-types.js'
import { createAuthVerifiers } from './infra/auth/verifiers.js'
import { ExternalAllowListProvider } from './features/enrollment/internal/allow-list.js'
import { RedisCache } from './infra/storage/redis-cache.js'

export * from './context-types.js'
export { SqliteSequenceOps } from './storage/sqlite/sequence-ops.js'
export { StratosActorStore } from './storage/sqlite/actor-store.js'
export { SqliteEnrollmentStore } from './storage/sqlite/enrollment-store.js'

/**
 * Loads the signing key from storage or creates a new one if it doesn't exist
 * @param cfg - Configuration options for the application context.
 * @returns Signing key
 */
async function loadSigningKey(
  cfg: AppContextOptions['cfg'],
): Promise<crypto.Keypair> {
  const keyPath = path.join(cfg.storage.dataDir, 'signing_key')
  if (await fileExists(keyPath)) {
    const keyBytes = await fs.readFile(keyPath)
    return await crypto.Secp256k1Keypair.import(keyBytes)
  } else {
    const signingKey = await crypto.Secp256k1Keypair.create({
      exportable: true,
    })
    const exported = await (signingKey as crypto.ExportableKeypair).export()
    await fs.writeFile(keyPath, exported)
    return signingKey
  }
}

/**
 * Create application context
 * @param opts - Configuration options for the application context.
 * @returns Initialized application context.
 */
// eslint-disable-next-line max-lines-per-function
export async function createAppContext(
  opts: AppContextOptions,
): Promise<AppContext> {
  const { cfg, logger } = opts

  const userAgent = buildUserAgent(
    VERSION,
    cfg.service.repoUrl || 'https://github.com/northskysocial/stratos',
    cfg.userAgent.operatorContact ?? 'unknown',
  )
  const fetchWithUserAgent = createFetchWithUserAgent(userAgent)

  const storage = await createStorageContext(opts)
  const { enrollmentStore, actorStore, destroy: storageDestroy } = storage

  const identity = await initIdentity(
    cfg,
    storage.oauthStores,
    fetchWithUserAgent,
    logger,
  )
  const { idResolver, signingKey, oauthClient } = identity

  const { enrollmentEvents, sequenceEvents } = initEventEmitters()

  const enrollmentCtx = await initEnrollment(
    cfg,
    enrollmentStore,
    actorStore,
    enrollmentEvents,
    idResolver,
    oauthClient,
    logger,
  )

  const allowListProvider = enrollmentCtx.allowListProvider

  const { dpopVerifier, authVerifier, lexiconProvider, xrpcServer } = initAuth(
    cfg,
    idResolver,
    oauthClient,
    enrollmentStore,
    enrollmentCtx.enrollmentValidator,
    allowListProvider,
    logger,
  )

  const cache = cfg.enrollment.valkeyUrl
    ? new RedisCache(cfg.enrollment.valkeyUrl)
    : undefined

  const boundaryResolver = cfg.enrollment.valkeyUrl
    ? new MigratingBoundaryResolver({
        enrollmentStore,
        serviceDid: getServiceDidWithFragment(cfg),
        logger,
      })
    : new EnrollmentBoundaryResolver(enrollmentStore)

  const blobCtx = initBlob(actorStore, boundaryResolver)

  const hydrationCtx = initHydration(
    actorStore,
    enrollmentStore,
    blobCtx.bloomManager,
    cache,
  )

  const syncCtx = { syncService: hydrationCtx.syncService }

  const mstCtx = initMst(signingKey)

  const repoCtx = initRepo(
    cfg,
    actorStore,
    mstCtx,
    sequenceEvents,
    oauthClient,
    getServiceDidWithFragment(cfg),
    logger,
  )

  const ctx: AppContext = {
    cfg,
    version: VERSION,
    ...identity,
    ...storage,
    ...enrollmentCtx,
    ...hydrationCtx,
    ...syncCtx,
    ...blobCtx,
    ...repoCtx,
    cache,
    signingDidKey: signingKey.did(),
    serviceDid: cfg.service.did,
    rateLimits: repoCtx.writeRateLimiter,
    authVerifier,
    xrpcServer,
    lexiconProvider,
    oauthStores: storage.oauthStores,
    app: initExpressApp(),
    logger,
    dpopVerifier,

    /**
     * Get the signing key for an actor by DID
     * @param did - The DID of the actor
     * @returns The signing key for the actor, or a new one if none exists
     */
    async getActorSigningKey(did: string) {
      const keypair = await actorStore.loadSigningKey(did)
      return keypair ?? (await actorStore.createSigningKey(did))
    },

    /**
     * Create an attestation for an actor
     * @param did - The DID of the actor
     * @param boundaries - The boundaries of the attestation
     * @param userDidKey - The DID key of the user
     * @returns The attestation signature and signing key
     */
    async createAttestation(
      did: string,
      boundaries: string[],
      userDidKey: string,
    ) {
      const payload = createAttestationPayload(did, boundaries, userDidKey)
      const sig = await signingKey.sign(payload)
      return { sig, signingKey: signingKey.did() }
    },

    /**
     * Check the health of the application
     * @returns Health status of the application
     */
    async checkHealth() {
      const dbOk = await storage.db
        ?.run(sql`SELECT 1`)
        .then(() => 'ok' as const)
        .catch(() => 'error' as const)
      return {
        status: dbOk === 'ok' ? 'ok' : 'error',
        components: {
          db: dbOk ?? 'error',
          blobstore: 'ok',
        },
      }
    },

    /**
     * Destroy the application context
     */
    async destroy() {
      await storageDestroy()
      repoCtx.repoWriteLocks.destroy()
      repoCtx.stubQueue.stop()
      if (enrollmentCtx.allowListProvider) {
        await enrollmentCtx.allowListProvider.stop()
      }
    },
  }

  setupMigrationCallback(ctx)

  return ctx
}

/**
 * Initializes identity components for the application context.
 * @param cfg - Configuration options for the application.
 * @param oauthStores - OAuth stores for token management.
 * @param fetchWithUserAgent - Fetch function with user agent.
 * @param logger - Optional logger for logging.
 * @returns Initialized identity components.
 */
async function initIdentity(
  cfg: AppContextOptions['cfg'],
  oauthStores: StorageContext['oauthStores'],
  fetchWithUserAgent: typeof globalThis.fetch,
  logger?: AppContext['logger'],
) {
  const idResolver = createIdResolver(cfg, fetchWithUserAgent, logger)
  const signingKey = await loadSigningKey(cfg)
  const oauthClient = await createOAuthClientContext(
    cfg,
    oauthStores as {
      sessionStore: OAuthSessionStoreBackend
      stateStore: OAuthStateStoreBackend
    },
    idResolver,
    fetchWithUserAgent,
  )
  return { idResolver, signingKey, oauthClient }
}

/**
 * Initializes authentication components for the application context.
 * @param cfg - Configuration options for the application.
 * @param idResolver - Identity resolver for user authentication.
 * @param oauthClient - OAuth client context for token management.
 * @param enrollmentStore - Store for managing user enrollments.
 * @param allowListProvider - Optional provider for external allowlists.
 * @param logger - Logger instance for logging application events.
 * @returns Initialized authentication components.
 */
function initAuth(
  cfg: AppContextOptions['cfg'],
  idResolver: AppContext['idResolver'],
  oauthClient: AppContext['oauthClient'],
  enrollmentStore: AppContext['enrollmentStore'],
  enrollmentValidator: AppContext['enrollmentValidator'],
  allowListProvider?: ExternalAllowListProvider,
  logger?: AppContext['logger'],
) {
  const dpopVerifier = new DpopVerifier({
    serviceDid: cfg.service.did,
    serviceEndpoint: cfg.service.publicUrl,
    enrollmentStore,
    allowListProvider,
  })

  const lexiconProvider = new DefaultLexiconProvider()
  const xrpcServer = new XrpcServer(lexiconProvider.getAll())

  const authVerifier = createAuthVerifiers(
    cfg.service.did,
    idResolver,
    oauthClient,
    cfg,
    enrollmentStore,
    cfg.admin?.password,
    dpopVerifier,
    allowListProvider,
    cfg.stratos.devMode === true,
    cfg.syncToken,
    logger,
  )

  return { dpopVerifier, authVerifier, lexiconProvider, xrpcServer }
}

/**
 * Initializes event emitters for the application context.
 * @returns Initialized event emitters.
 */
function initEventEmitters() {
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()
  const sequenceEvents: SequenceEventEmitter = new EventEmitter()
  sequenceEvents.setMaxListeners(0)
  return { enrollmentEvents, sequenceEvents }
}

/**
 * Initializes Express application for the application context.
 * @returns Initialized Express application.
 */
function initExpressApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  return app
}

/**
 * Sets up the migration callback for the application context.
 * @param ctx - Application context.
 */
function setupMigrationCallback(ctx: AppContext) {
  if (!(ctx.boundaryResolver instanceof MigratingBoundaryResolver)) return

  ctx.boundaryResolver.onMigrated = (did: string, boundaries: string[]) => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setImmediate(async () => {
      try {
        const isEnrolled = await ctx.enrollmentStore.isEnrolled(did)
        if (!isEnrolled) return

        await ctx.enrollmentStore.setBoundaries(did, boundaries)
        const signingKey = await ctx.getActorSigningKey(did)
        await ctx.profileRecordWriter.putEnrollmentRecord(did, 'self', {
          service: ctx.cfg.service.publicUrl,
          signingKey: signingKey.did(),
          boundaries: boundaries.map((b) => ({ value: b })),
          createdAt: new Date().toISOString(),
        })
      } catch (err) {
        ctx.logger?.error({ err, did }, 'failed to update boundaries for actor')
      }
    })
  }
}

/**
 * Destroy application context
 * @param ctx - Application context to destroy.
 */
export async function destroyAppContext(ctx: AppContext): Promise<void> {
  await ctx.destroy()
}
