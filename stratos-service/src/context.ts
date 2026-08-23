import path from 'node:path'
import * as fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import express from 'express'
import * as crypto from '@atproto/crypto'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { fileExists } from '@atproto/common'

import {
  createAttestationPayload,
  DefaultLexiconProvider,
  type Logger,
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
import {
  createAdminOAuthClientContext,
  createOAuthClientContext,
} from './oauth/client-factory.js'
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
  type IdentityContext,
} from './context-types.js'
import { createAuthVerifiers } from './infra/auth/verifiers.js'
import { replayStoreFromCache } from './infra/auth/replay-store.js'
import { JwksResolver } from './infra/auth/jwks-resolver.js'
import { ExternalAllowListProvider } from './features/enrollment/internal/allow-list.js'
import { RedisCache } from './infra/storage/redis-cache.js'
import { InProcessActorSigner } from './infra/signing/index.js'

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
  const { actorStore, destroy: storageDestroy } = storage

  const identity = await initIdentity(
    cfg,
    storage.oauthStores,
    fetchWithUserAgent,
    logger,
  )
  const { signingKey } = identity

  const { enrollmentEvents, sequenceEvents } = initEventEmitters()

  const services = await initCoreServices(
    cfg,
    storage,
    identity,
    enrollmentEvents,
    sequenceEvents,
    logger,
  )

  // Per-actor signing seam. Confines raw private key material — the TTL cache
  // and key-store access that previously lived here now live inside the signer.
  const actorSigner = new InProcessActorSigner(actorStore, { logger })

  // Shared external-client JWKS resolver. Process-wide so its TTL cache
  // is reused across `getSpaceCredential` requests. Uses the user-agent fetch.
  const jwksResolver = new JwksResolver({
    fetch: fetchWithUserAgent,
    cacheTtlMs: cfg.stratos.clientJwksCacheTtlMs,
    logger,
  })

  const ctx: AppContext = {
    cfg,
    version: VERSION,
    ...identity,
    ...storage,
    ...services.enrollmentCtx,
    ...services.hydrationCtx,
    ...services.blobCtx,
    ...services.repoCtx,
    ...services,
    signingDidKey: signingKey.did(),
    serviceDid: cfg.service.did,
    actorSigner,
    jwksResolver,
    app: initExpressApp(),
    logger,

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
      const dbOk = await storage.checkDbHealth()
      return {
        status: dbOk === 'ok' ? 'ok' : 'error',
        components: {
          db: dbOk,
          blobstore: 'ok',
        },
      }
    },

    /**
     * Destroy the application context
     */
    async destroy() {
      await storageDestroy()
      services.repoCtx.repoWriteLocks.destroy()
      if (services.enrollmentCtx.allowListProvider) {
        await services.enrollmentCtx.allowListProvider.stop()
      }
    },
  }

  setupMigrationCallback(ctx)

  return ctx
}

/**
 * Initializes core services for the application context.
 */
async function initCoreServices(
  cfg: AppContextOptions['cfg'],
  storage: StorageContext,
  identity: Pick<IdentityContext, 'idResolver' | 'signingKey' | 'oauthClient'>,
  enrollmentEvents: EnrollmentEventEmitter,
  sequenceEvents: SequenceEventEmitter,
  logger?: Logger,
) {
  const { enrollmentStore, actorStore, adminSessionStore, adminUserStore } =
    storage
  const { idResolver, signingKey, oauthClient } = identity

  const enrollmentCtx = await initEnrollment(
    cfg,
    enrollmentStore,
    actorStore,
    enrollmentEvents,
    idResolver,
    oauthClient,
    logger,
  )

  const cache = cfg.enrollment.valkeyUrl
    ? new RedisCache(cfg.enrollment.valkeyUrl)
    : undefined

  const { dpopVerifier, authVerifier, lexiconProvider, xrpcServer } = initAuth(
    cfg,
    idResolver,
    enrollmentStore,
    adminSessionStore,
    adminUserStore,
    enrollmentCtx.allowListProvider,
    signingKey,
    cache,
    logger,
  )

  const boundaryResolver = cfg.enrollment.valkeyUrl
    ? new MigratingBoundaryResolver({
        enrollmentStore,
        serviceDid: getServiceDidWithFragment(cfg),
        logger,
      })
    : new EnrollmentBoundaryResolver(enrollmentStore)

  const blobCtx = initBlob(actorStore, boundaryResolver, logger)

  const hydrationCtx = initHydration(actorStore, enrollmentStore, cache, logger)

  const mstCtx = initMst(signingKey)

  const repoCtx = initRepo(cfg, actorStore, mstCtx, sequenceEvents)

  return {
    enrollmentCtx,
    dpopVerifier,
    authVerifier,
    lexiconProvider,
    xrpcServer,
    cache,
    boundaryResolver,
    blobCtx,
    hydrationCtx,
    repoCtx,
  }
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
  const stores = oauthStores as {
    sessionStore: OAuthSessionStoreBackend
    stateStore: OAuthStateStoreBackend
  }
  const oauthClient = await createOAuthClientContext(
    cfg,
    stores,
    idResolver,
    fetchWithUserAgent,
  )
  const adminOauthClient = await createAdminOAuthClientContext(
    cfg,
    stores,
    idResolver,
    fetchWithUserAgent,
  )
  return { idResolver, signingKey, oauthClient, adminOauthClient }
}

/**
 * Initializes authentication components for the application context.
 * @param cfg - Configuration options for the application.
 * @param idResolver - Identity resolver for user authentication.
 * @param enrollmentStore - Store for managing user enrollments.
 * @param adminSessionStore - Admin web-session store.
 * @param adminUserStore - Store of admins granted at runtime.
 * @param allowListProvider - Optional provider for external allowlists.
 * @param signingKey - This service's signing keypair (space-credential authority).
 * @param cache - Process cache backing the DPoP-proof replay store, if any.
 * @param logger - Logger instance for logging application events.
 * @returns Initialized authentication components.
 */
function initAuth(
  cfg: AppContextOptions['cfg'],
  idResolver: AppContext['idResolver'],
  enrollmentStore: AppContext['enrollmentStore'],
  adminSessionStore: AppContext['adminSessionStore'],
  adminUserStore: AppContext['adminUserStore'],
  allowListProvider: ExternalAllowListProvider | undefined,
  signingKey: AppContext['signingKey'],
  cache: AppContext['cache'],
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
    cfg,
    enrollmentStore,
    adminSessionStore,
    adminUserStore,
    cfg.adminDids,
    dpopVerifier,
    allowListProvider,
    cfg.stratos.devMode === true,
    signingKey,
    replayStoreFromCache(cache, logger),
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

  ctx.boundaryResolver.onMigrated = (
    did: string,
    boundaries: string[],
    priorBoundaries: string[],
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setImmediate(async () => {
      try {
        const isEnrolled = await ctx.enrollmentStore.isEnrolled(did)
        if (!isEnrolled) return

        // `persistMigrated` already wrote the migrated set, so `priorBoundaries`
        // is supplied by the resolver (a store read here would return the
        // already-migrated set and suppress the event below).

        // Read-repair migration rewrites an actor's boundary set (e.g.
        // legacy bare names → qualified). Surface it on the service stream so
        // downstream caches invalidate without waiting for a TTL. Skip when the
        // set is unchanged (order-insensitive) to stay idempotent.
        if (!boundarySetsEqual(priorBoundaries, boundaries)) {
          ctx.enrollmentEvents.emit('enrollment', {
            did,
            action: 'boundaries',
            boundaries,
            priorBoundaries,
            time: new Date().toISOString(),
          })
        }

        const signingKeyDid = await ctx.actorSigner.getPublicKey(did)
        await ctx.profileRecordWriter.putEnrollmentRecord(did, 'self', {
          service: ctx.cfg.service.publicUrl,
          signingKey: signingKeyDid,
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
 * Whether two boundary sets are equal regardless of order or duplicates.
 * Compares deduplicated sizes (raw lengths would let a list with duplicates
 * pass as equal to a distinct set of the same length).
 * @param a - First boundary set
 * @param b - Second boundary set
 * @returns True if both sets contain exactly the same boundaries
 */
function boundarySetsEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const x of setB) {
    if (!setA.has(x)) return false
  }
  return true
}

/**
 * Destroy application context
 * @param ctx - Application context to destroy.
 */
export async function destroyAppContext(ctx: AppContext): Promise<void> {
  await ctx.destroy()
}
