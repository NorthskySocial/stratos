import * as fsSync from 'node:fs'
import path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import express from 'express'
import * as crypto from '@atproto/crypto'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { Agent } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import { fileExists } from '@atproto/common'
import { WriteRateLimiter } from './rate-limiter.js'
import { RepoWriteLocks } from './repo-write-lock.js'

import { createAttestationPayload, DID } from '@northskysocial/stratos-core'
import {
  BackgroundStubQueue,
  ExternalAllowListProvider,
  MigratingBoundaryResolver,
  PdsAgent,
  ProfileRecordWriterImpl,
  StubWriterServiceImpl,
} from './features/index.js'

import { getServiceDidWithFragment } from './config.js'
import { createStorageContext } from './storage-context.js'
import { createIdResolver } from './identity-resolver.js'
import { createOAuthClientContext } from './oauth/client-factory.js'
import { DpopVerifier } from './auth/index.js'
import { buildUserAgent, createFetchWithUserAgent } from './user-agent.js'
import { VERSION } from './version.js'
import { RedisCache } from './adapters/redis-cache.js'
import { ServiceFactory } from './service-factory.js'
import {
  type AppContext,
  type AppContextOptions,
  type EnrollmentEventEmitter,
  type SequenceEventEmitter,
} from './context-types.js'
import { createAuthVerifiers } from './auth/verifiers.js'

export * from './context-types.js'
export { SqliteSequenceOps } from './storage/sqlite/sequence-ops.js'
export { StratosActorStore } from './storage/sqlite/actor-store.js'
export { SqliteEnrollmentStore } from './storage/sqlite/enrollment-store.js'

/**
 * Load Stratos lexicon documents from the lexicons directory
 */
export function loadStratosLexicons(): LexiconDoc[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const lexiconsDir = path.resolve(__dirname, 'lexicons')
  const lexicons: LexiconDoc[] = []

  function loadFromDir(dir: string) {
    if (!fsSync.existsSync(dir)) return
    try {
      const entries = fsSync.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          loadFromDir(fullPath)
        } else if (entry.name.endsWith('.json')) {
          const content = fsSync.readFileSync(fullPath, 'utf-8')
          const doc = JSON.parse(content) as LexiconDoc
          if (doc && doc.id) {
            lexicons.push(doc)
          }
        }
      }
    } catch (err) {
      console.warn(`[DEBUG_LOG] Error loading lexicon from ${dir}:`, err)
    }
  }

  console.log(`[DEBUG_LOG] Loading lexicons from: ${lexiconsDir}`)
  loadFromDir(lexiconsDir)
  console.log(`[DEBUG_LOG] Loaded ${lexicons.length} lexicons`)
  if (lexicons.length === 0) {
    // Return at least one valid lexicon to satisfy XrpcServer
    return [
      {
        lexicon: 1,
        id: 'zone.stratos.empty',
        defs: { main: { type: 'query' } },
      } as LexiconDoc,
    ]
  }
  return lexicons
}

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
    cfg.userAgent.repoUrl,
    cfg.userAgent.operatorContact,
  )
  const fetchWithUserAgent = createFetchWithUserAgent(userAgent)

  const {
    db,
    enrollmentStore,
    actorStore,
    oauthStores,
    destroy: storageDestroy,
  } = await createStorageContext(opts)

  const idResolver = createIdResolver(cfg, fetchWithUserAgent, logger)
  const signingKey = await loadSigningKey(cfg)

  const oauthClient = await createOAuthClientContext(
    cfg,
    oauthStores,
    idResolver,
    fetchWithUserAgent,
  )

  const { enrollmentEvents, sequenceEvents } = initEventEmitters()

  const serviceFactory = new ServiceFactory({
    enrollmentStore,
    actorStore,
    enrollmentEvents,
    serviceUrl: cfg.service.publicUrl,
    signingKey,
    logger,
  })

  const allowListProvider = await initAllowListProvider(cfg, logger)

  const dpopVerifier = new DpopVerifier({
    serviceDid: cfg.service.did,
    serviceEndpoint: cfg.service.publicUrl,
    enrollmentStore,
    allowListProvider,
  })

  const authVerifier = createAuthVerifiers(
    cfg.service.did,
    idResolver,
    oauthClient,
    enrollmentStore,
    cfg.admin?.password,
    dpopVerifier,
    allowListProvider,
    cfg.stratos.devMode === true,
    cfg.syncToken,
  )

  const stubWriter = initStubWriter(oauthClient, getServiceDidWithFragment(cfg))

  const ctx: AppContext = {
    cfg,
    version: VERSION,
    idResolver,
    oauthClient,
    signingKey,
    signingDidKey: signingKey.did(),
    serviceDid: cfg.service.did,
    enrollmentStore,
    actorStore,
    db,
    writeRateLimiter: new WriteRateLimiter({
      maxWrites: cfg.stratos?.writeRateLimit?.maxWrites ?? 300,
      windowMs: cfg.stratos?.writeRateLimit?.windowMs ?? 60000,
      cooldownMs: cfg.stratos?.writeRateLimit?.cooldownMs ?? 10000,
      cooldownJitterMs: cfg.stratos?.writeRateLimit?.cooldownJitterMs ?? 0,
    }),
    rateLimits: undefined as any, // initialized below
    repoWriteLocks: new RepoWriteLocks(),
    enrollmentService: serviceFactory.createEnrollmentService(),
    profileRecordWriter: initProfileRecordWriter(oauthClient),
    boundaryResolver: serviceFactory.createBoundaryResolver(),
    stubWriter,
    stubQueue: new BackgroundStubQueue(stubWriter, logger),
    authVerifier,
    allowListProvider,
    xrpcServer: new XrpcServer(loadStratosLexicons()),
    app: initExpressApp(),
    logger,
    dpopVerifier,
    enrollmentEvents,
    sequenceEvents,

    async getActorSigningKey(did: string) {
      const keypair = await actorStore.loadSigningKey(did)
      return keypair ?? (await actorStore.createSigningKey(did))
    },

    async createAttestation(
      did: string,
      boundaries: string[],
      userDidKey: string,
    ) {
      const payload = createAttestationPayload(did, boundaries, userDidKey)
      const sig = await signingKey.sign(payload)
      return { sig, signingKey: signingKey.did() }
    },

    async checkHealth() {
      return { status: 'ok', components: { db: 'ok', blobstore: 'ok' } }
    },

    async destroy() {
      await storageDestroy()
      if (allowListProvider) await allowListProvider.stop()
      this.stubQueue.stop()
    },
  }

  setupMigrationCallback(ctx)

  return ctx
}

function initEventEmitters() {
  const enrollmentEvents: EnrollmentEventEmitter = new EventEmitter()
  const sequenceEvents: SequenceEventEmitter = new EventEmitter()
  sequenceEvents.setMaxListeners(0)
  return { enrollmentEvents, sequenceEvents }
}

function initStubWriter(
  oauthClient: AppContext['oauthClient'],
  serviceDidWithFragment: string,
): StubWriterServiceImpl {
  return new StubWriterServiceImpl(async (did) => {
    try {
      const session = await oauthClient.restore(did)
      return new Agent(session) as unknown as PdsAgent
    } catch {
      return null
    }
  }, serviceDidWithFragment)
}

function initProfileRecordWriter(
  oauthClient: AppContext['oauthClient'],
): ProfileRecordWriterImpl {
  return new ProfileRecordWriterImpl(async (did: string) => {
    try {
      const session = await oauthClient.restore(did)
      return { api: new Agent(session) }
    } catch {
      return null
    }
  })
}

async function initAllowListProvider(
  cfg: AppContextOptions['cfg'],
  logger?: AppContext['logger'],
): Promise<ExternalAllowListProvider | undefined> {
  if (!cfg.enrollment.allowListUrl) return undefined
  const cache = cfg.enrollment.valkeyUrl
    ? new RedisCache(cfg.enrollment.valkeyUrl)
    : undefined
  const provider = new ExternalAllowListProvider(
    cfg.enrollment.allowListUrl,
    cache,
    cfg.enrollment.allowListBootstrapName,
    logger,
  )
  await provider.start()
  return provider
}

function initExpressApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  return app
}

function setupMigrationCallback(ctx: AppContext) {
  if (!(ctx.boundaryResolver instanceof MigratingBoundaryResolver)) return

  ctx.boundaryResolver.onMigrated = (did: string, boundaries: string[]) => {
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
