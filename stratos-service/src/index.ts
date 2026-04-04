import type http from 'node:http'
import path from 'node:path'
import express from 'express'
import './types.js'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { decode as cborDecode } from '@atproto/lex-cbor'
import { isTypedLexMap } from '@atproto/lex-data'
import { randomBytes } from 'node:crypto'
import type { BlobStoreCreator, Logger } from '@northskysocial/stratos-core'
import { buildCommit, StratosError } from '@northskysocial/stratos-core'
import {
  type AppContext,
  createAppContext,
  destroyAppContext,
} from './context.js'
import { createLogger } from './logger.js'
import { envToConfig, parseEnv, type StratosServiceConfig } from './config.js'
import { registerHandlers } from './api/handlers.js'
import { registerSubscribeRecords } from './subscription/index.js'
import { createOAuthRoutes } from './oauth/routes.js'
import { DiskBlobStore, S3BlobStoreAdapter } from './infra/blobstore/index.js'
import {
  registerEnrollmentHandlers,
  registerHydrationHandlers,
  signAndPersistCommit,
  StratosBlockStoreReader,
} from './features/index.js'

export { type StratosServiceConfig, type AppContext }
export { DiskBlobStore, S3BlobStoreAdapter } from './infra/blobstore/index.js'
export * from './shared/user-agent.js'

/**
 * Stratos service server
 */
export class StratosServer {
  public ctx: AppContext
  public server: http.Server | null = null
  private app: express.Application

  constructor(ctx: AppContext, app: express.Application) {
    this.ctx = ctx
    this.app = app
  }

  /**
   * Create and start the Stratos server
   *
   * @param cfg - Stratos service configuration
   * @param blobstore - Blob store creator
   * @param cborToRecord - CBOR to record conversion function
   * @param logger - Optional logger instance
   * @returns Promise resolving to StratosServer instance
   */
  static async create(
    cfg: StratosServiceConfig,
    blobstore: BlobStoreCreator,
    cborToRecord: (content: Uint8Array) => Record<string, unknown>,
    logger?: Logger,
  ): Promise<StratosServer> {
    const ctx = await createAppContext({
      cfg,
      blobstore,
      cborToRecord,
      logger,
    })

    const app = ctx.app
    this.setupMiddleware(app, ctx)
    this.registerRoutes(app, ctx, cfg)

    return new StratosServer(ctx, app)
  }

  /**
   * Setup middleware for the Stratos server
   *
   * @param app - Express application instance
   * @param ctx - Application context
   */
  private static setupMiddleware(app: express.Application, ctx: AppContext) {
    // Trace ID middleware
    app.use((req, res, next) => {
      const traceId =
        (req.headers['x-trace-id'] as string) || randomBytes(8).toString('hex')
      req.traceId = traceId
      res.setHeader('x-trace-id', traceId)
      next()
    })

    app.use(
      cors({
        exposedHeaders: ['DPoP-Nonce', 'WWW-Authenticate', 'x-trace-id'],
      }),
    )
    app.use(cookieParser())

    // Logging middleware with traceId
    app.use((req, res, next) => {
      const start = Date.now()
      res.on('finish', () => {
        const durationMs = Date.now() - start
        ctx.logger?.info(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs,
            traceId: req.traceId,
          },
          'http request completed',
        )
      })
      next()
    })

    // Exclude /xrpc/ routes from express.json() - xrpc-server handles its own body parsing
    app.use((req, res, next) => {
      if (req.path.startsWith('/xrpc/')) {
        return next()
      }
      express.json({ limit: '100kb' })(req, res, next)
    })
  }

  /**
   * Register routes for the Stratos server
   *
   * @param app - Express application instance
   * @param ctx - Application context
   * @param cfg - Stratos service configuration
   */
  private static registerRoutes(
    app: express.Application,
    ctx: AppContext,
    cfg: StratosServiceConfig,
  ) {
    this.registerHomeRoute(app, cfg)
    this.registerHealthRoutes(app, ctx)
    this.registerWellKnownRoutes(app, ctx, cfg)
    this.registerStaticRoutes(app, cfg)
    this.registerOAuthRoutes(app, ctx, cfg)
    this.registerFeatureHandlers(app, ctx)
    this.registerErrorMiddleware(app, ctx, cfg)
  }

  private static registerHomeRoute(
    app: express.Application,
    cfg: StratosServiceConfig,
  ) {
    app.get('/', (_req, res) => {
      res.type('text/plain')
      res.send(
        [
          '',
          '       \u2588\u2588\u2588\u2588\u2588\u2588\u2588     \u2588\u2588\u2588\u2588           \u2588     \u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588                   \u2588\u2588\u2588\u2588           \u2588      \u2588 \u2588\u2588\u2588         \u2588\u2588\u2588\u2588\u2588\u2588\u2588   ',
          '     \u2588       \u2588\u2588\u2588  \u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588  \u2588 \u2588\u2588     \u2588\u2588\u2588\u2588\u2588        \u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588     \u2588  \u2588\u2588\u2588\u2588       \u2588       \u2588\u2588\u2588 ',
          '    \u2588         \u2588\u2588 \u2588     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588    \u2588\u2588   \u2588  \u2588  \u2588\u2588    \u2588  \u2588\u2588\u2588       \u2588     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588      \u2588  \u2588  \u2588\u2588\u2588     \u2588         \u2588\u2588 ',
          '    \u2588\u2588        \u2588  \u2588     \u2588  \u2588        \u2588    \u2588  \u2588   \u2588\u2588       \u2588\u2588\u2588       \u2588     \u2588  \u2588          \u2588  \u2588\u2588   \u2588\u2588\u2588    \u2588\u2588        \u2588  ',
          '     \u2588\u2588\u2588          \u2588\u2588  \u2588  \u2588\u2588            \u2588  \u2588    \u2588       \u2588  \u2588\u2588       \u2588\u2588  \u2588  \u2588\u2588         \u2588  \u2588\u2588\u2588    \u2588\u2588\u2588    \u2588\u2588\u2588         ',
          '    \u2588\u2588 \u2588\u2588\u2588           \u2588  \u2588\u2588\u2588           \u2588\u2588 \u2588\u2588   \u2588        \u2588  \u2588\u2588          \u2588  \u2588\u2588\u2588        \u2588\u2588   \u2588\u2588     \u2588\u2588   \u2588\u2588 \u2588\u2588\u2588       ',
          '     \u2588\u2588\u2588 \u2588\u2588\u2588        \u2588\u2588   \u2588\u2588           \u2588\u2588 \u2588\u2588  \u2588        \u2588    \u2588\u2588        \u2588\u2588   \u2588\u2588        \u2588\u2588   \u2588\u2588     \u2588\u2588    \u2588\u2588\u2588 \u2588\u2588\u2588     ',
          '       \u2588\u2588\u2588 \u2588\u2588\u2588      \u2588\u2588   \u2588\u2588           \u2588\u2588 \u2588\u2588\u2588\u2588         \u2588    \u2588\u2588        \u2588\u2588   \u2588\u2588        \u2588\u2588   \u2588\u2588     \u2588\u2588      \u2588\u2588\u2588 \u2588\u2588\u2588   ',
          '         \u2588\u2588\u2588 \u2588\u2588\u2588    \u2588\u2588   \u2588\u2588           \u2588\u2588 \u2588\u2588  \u2588\u2588\u2588     \u2588      \u2588\u2588       \u2588\u2588   \u2588\u2588        \u2588\u2588   \u2588\u2588     \u2588\u2588        \u2588\u2588\u2588 \u2588\u2588\u2588 ',
          '           \u2588\u2588 \u2588\u2588\u2588   \u2588\u2588   \u2588\u2588           \u2588\u2588 \u2588\u2588    \u2588\u2588    \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588       \u2588\u2588   \u2588\u2588        \u2588\u2588   \u2588\u2588     \u2588\u2588          \u2588\u2588 \u2588\u2588\u2588',
          '            \u2588\u2588 \u2588\u2588    \u2588\u2588  \u2588\u2588           \u2588  \u2588\u2588    \u2588\u2588   \u2588        \u2588\u2588       \u2588\u2588  \u2588\u2588         \u2588\u2588  \u2588\u2588     \u2588\u2588           \u2588\u2588 \u2588\u2588',
          '             \u2588 \u2588      \u2588\u2588 \u2588      \u2588        \u2588     \u2588\u2588   \u2588        \u2588\u2588        \u2588\u2588 \u2588      \u2588    \u2588\u2588 \u2588      \u2588             \u2588 \u2588 ',
          '   \u2588\u2588\u2588        \u2588        \u2588\u2588\u2588     \u2588     \u2588\u2588\u2588\u2588      \u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588      \u2588\u2588        \u2588\u2588\u2588     \u2588      \u2588\u2588\u2588     \u2588    \u2588\u2588\u2588        \u2588  ',
          '  \u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588          \u2588\u2588\u2588\u2588\u2588\u2588\u2588     \u2588  \u2588\u2588\u2588\u2588    \u2588\u2588 \u2588   \u2588\u2588\u2588\u2588    \u2588\u2588 \u2588       \u2588\u2588\u2588\u2588\u2588\u2588\u2588        \u2588\u2588\u2588\u2588\u2588\u2588\u2588    \u2588  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   ',
          ' \u2588     \u2588\u2588\u2588\u2588\u2588              \u2588\u2588\u2588      \u2588    \u2588\u2588     \u2588 \u2588     \u2588\u2588      \u2588\u2588          \u2588\u2588\u2588            \u2588\u2588\u2588     \u2588     \u2588\u2588\u2588\u2588\u2588     ',
          ' \u2588                                 \u2588             \u2588                                                \u2588               ',
          '  \u2588                                 \u2588             \u2588                                                \u2588              ',
          '   \u2588\u2588                                \u2588\u2588            \u2588\u2588                                               \u2588\u2588            ',
          '',
          '',
          '  This is Stratos, a private permissioned data service for AT Protocol',
          '',
          '  Most API routes are under /xrpc/',
          '',
          `        Code: ${cfg.service.repoUrl}`,
          '    Protocol: https://atproto.com',
          '',
        ].join('\n'),
      )
    })
  }

  private static registerHealthRoutes(
    app: express.Application,
    ctx: AppContext,
  ) {
    app.get('/health', async (_req, res) => {
      const health = await ctx.checkHealth()
      res.status(health.status === 'ok' ? 200 : 503).json({
        ...health,
        version: ctx.version,
      })
    })

    app.get('/ready', async (_req, res) => {
      const health = await ctx.checkHealth()
      res.status(health.status === 'ok' ? 200 : 503).json({
        ...health,
        version: ctx.version,
      })
    })
  }

  private static registerWellKnownRoutes(
    app: express.Application,
    ctx: AppContext,
    cfg: StratosServiceConfig,
  ) {
    app.get('/robots.txt', (_req, res) => {
      res.type('text/plain')
      res.send(
        '# Hello! Crawling these APIs is not allowed\n\nUser-agent: *\nDisallow: /',
      )
    })

    app.get('/.well-known/did.json', (_req, res) => {
      const serviceDid = ctx.serviceDid
      const serviceEndpoint = cfg.service.publicUrl
      const publicKeyMultibase = ctx.signingDidKey.slice('did:key:'.length)

      res.json({
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/multikey/v1',
        ],
        id: serviceDid,
        verificationMethod: [
          {
            id: `${serviceDid}#${cfg.service.serviceFragment}`,
            type: 'Multikey',
            controller: serviceDid,
            publicKeyMultibase,
          },
        ],
        service: [
          {
            id: '#stratos',
            type: 'StratosService',
            serviceEndpoint,
          },
        ],
      })
    })

    const metadataHandler = (_req: express.Request, res: express.Response) => {
      res.json(ctx.oauthClient.clientMetadata)
    }

    app.get('/client-metadata.json', metadataHandler)
    app.get('/.well-known/oauth-client-metadata.json', metadataHandler)
  }

  private static registerStaticRoutes(
    app: express.Application,
    cfg: StratosServiceConfig,
  ) {
    app.use('/assets', express.static(path.join(cfg.storage.dataDir, 'assets')))
  }

  private static registerOAuthRoutes(
    app: express.Application,
    ctx: AppContext,
    cfg: StratosServiceConfig,
  ) {
    const oauthRoutes = createOAuthRoutes({
      oauthClient: ctx.oauthClient,
      enrollmentConfig: cfg.enrollment,
      enrollmentStore: ctx.enrollmentStore,
      idResolver: ctx.idResolver,
      baseUrl: cfg.service.publicUrl,
      serviceEndpoint: cfg.service.publicUrl,
      serviceDid: ctx.serviceDid,
      defaultBoundaries: cfg.stratos.allowedDomains,
      autoEnrollDomains: cfg.enrollment.autoEnrollDomains,
      logger: ctx.logger,
      devMode: cfg.stratos.devMode === true,
      dpopVerifier: ctx.dpopVerifier,
      profileRecordWriter: ctx.profileRecordWriter,
      initRepo: async (did: string) => {
        await ctx.actorStore.create(did)
        await ctx.actorStore.transact(did, async (store) => {
          const adapter = new StratosBlockStoreReader(store.repo)
          const unsigned = await buildCommit(adapter, null, {
            did,
            writes: [],
          })
          await signAndPersistCommit(store.repo, ctx.signingKey, unsigned)
        })
      },
      createSigningKey: async (did: string) => {
        const keypair = await ctx.actorStore.createSigningKey(did)
        return keypair.did()
      },
      createAttestation: ctx.createAttestation,
    })
    app.use('/oauth', oauthRoutes)
  }

  private static registerFeatureHandlers(
    app: express.Application,
    ctx: AppContext,
  ) {
    registerHandlers(ctx.xrpcServer, ctx)
    registerEnrollmentHandlers(ctx.xrpcServer, ctx)
    registerHydrationHandlers(ctx.xrpcServer, ctx)
    registerSubscribeRecords(ctx)
    app.use(ctx.xrpcServer.router)
  }

  private static registerErrorMiddleware(
    app: express.Application,
    ctx: AppContext,
    cfg: StratosServiceConfig,
  ) {
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,

        _next: express.NextFunction,
      ) => {
        if (err instanceof StratosError) {
          ctx.logger?.warn(
            {
              code: err.code,
              err: err.message,
              cause: err.cause,
            },
            'domain error',
          )
          res.status(400).json({
            error: err.code,
            message: err.message,
          })
          return
        }
        if (
          'retryAfter' in err &&
          typeof (err as Record<string, unknown>).retryAfter === 'number'
        ) {
          const retryAfter = (err as Record<string, unknown>)
            .retryAfter as number
          res.set('Retry-After', String(retryAfter))
          res.status(429).json({
            error: 'RateLimitExceeded',
            message: err.message,
          })
          return
        }
        console.error('Express error:', err.message)
        console.error(err.stack)
        ctx.logger?.error(
          {
            err: err.message,
            stack: cfg.stratos.devMode ? err.stack : undefined,
          },
          'server error',
        )
        res.status(500).json({
          error: 'InternalServerError',
          message: cfg.stratos.devMode ? err.message : 'Internal server error',
        })
      },
    )
  }

  /**
   * Start listening on configured port
   */
  async start(): Promise<void> {
    const port = this.ctx.cfg.service.port

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        const upgradeListeners = this.server?.listenerCount('upgrade') ?? 0
        this.ctx.logger?.info(
          { port, upgradeListeners },
          'stratos server started',
        )
        resolve()
      })
    })
  }

  /**
   * Gracefully stop the server
   */
  async stop(): Promise<void> {
    this.ctx.logger?.info('stopping stratos server...')
    if (this.server) {
      // 1. Stop accepting new connections
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err) => {
          if (err) {
            this.ctx.logger?.error({ err }, 'error closing http server')
            reject(err)
          } else {
            this.ctx.logger?.info('http server closed')
            resolve()
          }
        })
      })
    }

    // 2. Destroy application context (DBs, stores, etc.)
    try {
      await destroyAppContext(this.ctx)
      this.ctx.logger?.info('application context destroyed')
    } catch (err) {
      this.ctx.logger?.error({ err }, 'error destroying application context')
      throw err
    }
  }
}

/**
 * Create a blobstore factory from config
 *
 * @param cfg - Stratos service configuration
 * @returns Blob store creator function
 */
function createBlobstore(cfg: StratosServiceConfig): BlobStoreCreator {
  if (cfg.blobstore.provider === 's3') {
    return S3BlobStoreAdapter.creator({
      bucket: cfg.blobstore.bucket,
      region: cfg.blobstore.region,
      endpoint: cfg.blobstore.endpoint,
      forcePathStyle: cfg.blobstore.forcePathStyle,
      accessKeyId: cfg.blobstore.accessKeyId,
      secretAccessKey: cfg.blobstore.secretAccessKey,
      pathPrefix: cfg.blobstore.pathPrefix,
      uploadTimeoutMs: cfg.blobstore.uploadTimeoutMs,
    })
  }
  return DiskBlobStore.creator(
    cfg.blobstore.location,
    cfg.blobstore.tempLocation,
    cfg.blobstore.quarantineLocation,
  )
}

/**
 * Main entry point - create server from environment
 */
export async function main(): Promise<void> {
  const cfg = envToConfig(parseEnv())

  const logger = createLogger(cfg.logging.level)

  const blobstore = createBlobstore(cfg)

  const cborToRecord = (bytes: Uint8Array): Record<string, unknown> => {
    const data = cborDecode(bytes)
    if (isTypedLexMap(data)) return data
    throw new Error('Expected record with $type property')
  }

  const server = await StratosServer.create(
    cfg,
    blobstore,
    cborToRecord,
    logger,
  )
  await server.start()

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('SIGTERM', async () => {
    server.ctx.logger?.info('SIGTERM received, shutting down...')
    await server.stop()
    process.exit(0)
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('SIGINT', async () => {
    server.ctx.logger?.info('SIGINT received, shutting down...')
    await server.stop()
    process.exit(0)
  })
}

// Run if executed directly
if (process.argv[1] === import.meta.url.slice(7)) {
  main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
}
