import { config as dotenvConfig } from 'dotenv'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'
import express from 'express'
import './types.js'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { decode as cborDecode } from '@atproto/lex-cbor'
import { isTypedLexMap } from '@atproto/lex-data'
import { randomBytes } from 'node:crypto'
import * as Sentry from '@sentry/node'
import type { BlobStoreCreator, Logger } from '@northskysocial/stratos-core'
import { buildCommit, StratosError } from '@northskysocial/stratos-core'
import {
  type AppContext,
  createAppContext,
  destroyAppContext,
} from './context.js'
import { createLogger } from './logger.js'
import {
  envToConfig,
  isAllowedCredentialedOrigin,
  parseEnv,
  type StratosServiceConfig,
} from './config.js'
import { registerHandlers } from './api'
import { createRecord } from './api/records/index.js'
import { registerSubscribeRecords } from './subscription'
import { createAdminAuthRoutes, createOAuthRoutes } from './oauth'
import { DiskBlobStore, S3BlobStoreAdapter } from './infra/blobstore'
import { SPACE_CREDENTIAL_KID } from './infra/auth/space-credential-verifier.js'
import { signAndPersistCommit, StratosBlockStoreReader } from './features'
import { reconcileServiceEnrollments } from './features/enrollment'
import {
  captureUnexpectedError,
  shutdownTelemetry,
} from './observability/runtime.js'
import {
  normalizeServiceRoute,
  serviceMetrics,
} from './observability/metrics.js'

dotenvConfig({ path: path.join(process.cwd(), '../.env'), override: false })
dotenvConfig({ override: false })

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

    await reconcileServiceEnrollments(cfg.enrollment.serviceEnrollments, {
      store: ctx.enrollmentStore,
      signingKeyDid: ctx.signingDidKey,
      logger: ctx.logger,
    })

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
      cors((req: express.Request, callback) => {
        const origin = req.headers.origin
        const credentialed = isAllowedCredentialedOrigin(origin, {
          publicUrl: ctx.cfg.service.publicUrl,
          devMode: ctx.cfg.stratos.devMode === true,
        })
        const allowTracingHeaders =
          origin !== undefined &&
          ctx.cfg.allowedRedirectOrigins.includes(origin)
        callback(null, {
          // Reflect the request origin for the non-credentialed DPoP/XRPC
          // surface; only allowlisted origins additionally receive
          // `Access-Control-Allow-Credentials`, so no untrusted site can ride
          // the admin session cookie.
          origin: true,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
          allowedHeaders: [
            'Authorization',
            'Content-Type',
            'DPoP',
            'DPoP-Nonce',
            'x-trace-id',
            'atproto-accept-labelers',
            'atproto-proxy-type',
            'ngrok-skip-browser-warning',
            ...(allowTracingHeaders ? ['sentry-trace', 'baggage'] : []),
          ],
          exposedHeaders: ['DPoP-Nonce', 'WWW-Authenticate', 'x-trace-id'],
          credentials: credentialed,
          maxAge: 86400,
          preflightContinue: false,
          optionsSuccessStatus: 204,
        })
      }),
    )
    app.use(cookieParser())

    // Logging middleware with traceId
    app.use((req, res, next) => {
      const startedAt = process.hrtime.bigint()
      const completeMetrics = serviceMetrics.beginHttpRequest()
      res.on('finish', () => {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000
        const route = normalizeServiceRoute(req.path)
        completeMetrics({
          method: req.method,
          route,
          status: res.statusCode,
          durationSeconds: durationMs / 1_000,
        })
        if (route.startsWith('/xrpc/')) {
          serviceMetrics.recordAuth(
            res.statusCode === 401 || res.statusCode === 403
              ? 'rejected'
              : res.statusCode >= 500
                ? 'error'
                : 'ok',
          )
        }
        const activeSpan = Sentry.getActiveSpan()
        const span = activeSpan ? Sentry.spanToJSON(activeSpan) : undefined
        ctx.logger?.info(
          {
            method: req.method,
            path: route,
            status: res.statusCode,
            durationMs,
            traceId: req.traceId,
            sentryTraceId: span?.trace_id,
            sentrySpanId: span?.span_id,
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
    this.registerAdminAuthRoutes(app, ctx, cfg)
    this.registerFeatureHandlers(app, ctx)
    this.registerErrorMiddleware(app, ctx, cfg)
  }

  /**
   * Register the home route for the Stratos service.
   * @param app - Express application instance
   * @param cfg - Stratos service configuration
   * @private
   */
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

  /**
   * Register health-related routes for the Stratos service.
   * @param app - Express application instance
   * @param ctx - Application context
   * @private
   */
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

  /**
   * Register well-known routes for the Stratos service.
   * @param app - Express application instance
   * @param ctx - Application context
   * @param cfg - Stratos service configuration
   * @private
   */
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

      // A foreign spaces PDS accepts only the `#atproto` or `#atproto_space`
      // key fragment when it verifies a space credential. Publish `#atproto`
      // as well, so a foreign host can verify credentials that this service
      // mints. Both entries carry the same key.
      const verificationMethod = [
        {
          id: `${serviceDid}#${cfg.service.serviceFragment}`,
          type: 'Multikey',
          controller: serviceDid,
          publicKeyMultibase,
        },
      ]
      const spaceKeyFragment = SPACE_CREDENTIAL_KID.slice('#'.length)
      if (cfg.service.serviceFragment !== spaceKeyFragment) {
        verificationMethod.push({
          id: `${serviceDid}#${spaceKeyFragment}`,
          type: 'Multikey',
          controller: serviceDid,
          publicKeyMultibase,
        })
      }

      res.json({
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/multikey/v1',
        ],
        id: serviceDid,
        verificationMethod,
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

  /**
   * Register static routes for serving assets and the built admin UI.
   *
   * The admin UI mount at `/admin` is registered before the admin auth router
   * (`/admin/oauth/*`, `/admin/whoami`); `express.static` only responds when a
   * matching file exists, so API paths fall through to the router. The SPA uses
   * hash routing, so `/admin/` + `index.html` covers every client route and no
   * wildcard fallback is needed.
   * @param app - Express application instance
   * @param cfg - Stratos service configuration
   * @private
   */
  private static registerStaticRoutes(
    app: express.Application,
    cfg: StratosServiceConfig,
  ) {
    app.use('/assets', express.static(path.join(cfg.storage.dataDir, 'assets')))

    const adminUiDir = this.resolveAdminUiDir()
    if (adminUiDir) {
      app.use('/admin', express.static(adminUiDir))
    }
  }

  /**
   * Locate the built admin UI. `build:admin` outputs to `dist/admin-ui`; when
   * running compiled code this module sits in `dist/`, while `tsx` runs it
   * from `src/`, so both locations are probed.
   * @returns Directory containing the built admin UI, or undefined if absent
   * @private
   */
  private static resolveAdminUiDir(): string | undefined {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.join(moduleDir, 'admin-ui'),
      path.join(moduleDir, '..', 'dist', 'admin-ui'),
    ]
    return candidates.find((dir) => existsSync(path.join(dir, 'index.html')))
  }

  /**
   * Register OAuth-related routes for the Stratos service.
   * @param app - Express application instance
   * @param ctx - Application context
   * @param cfg - Stratos service configuration
   * @private
   */
  private static registerOAuthRoutes(
    app: express.Application,
    ctx: AppContext,
    cfg: StratosServiceConfig,
  ) {
    const oauthRoutes = createOAuthRoutes({
      oauthClient: ctx.oauthClient,
      enrollmentConfig: cfg.enrollment,
      enrollmentStore: ctx.enrollmentStore,
      enrollmentValidator: ctx.enrollmentValidator,
      idResolver: ctx.idResolver,
      baseUrl: cfg.service.publicUrl,
      serviceEndpoint: cfg.service.publicUrl,
      serviceDid: ctx.serviceDid,
      defaultBoundaries: cfg.stratos.allowedDomains,
      autoEnrollDomains: cfg.enrollment.autoEnrollDomains,
      roomCatalog: cfg.roomCatalog,
      reservedBoundary: cfg.stratos.reservedDomain,
      allowedRedirectOrigins: cfg.allowedRedirectOrigins,
      logger: ctx.logger,
      devMode: cfg.stratos.devMode === true,
      dpopVerifier: ctx.dpopVerifier,
      profileRecordWriter: ctx.profileRecordWriter,
      repoWriteLocks: ctx.repoWriteLocks,
      initRepo: async (did: string) => {
        await ctx.actorStore.create(did)
        await ctx.actorStore.transact(did, async (store) => {
          const adapter = new StratosBlockStoreReader(store.repo)
          const unsigned = await buildCommit(adapter, null, {
            did,
            writes: [],
          })
          // The empty initial commit is signed with the service key (unchanged
          // behavior); wrap its sign() to match signAndPersistCommit's SignFn.
          await signAndPersistCommit(
            store.repo,
            (bytes) => ctx.signingKey.sign(bytes),
            unsigned,
          )
        })
      },
      createSigningKey: async (did: string) => {
        await ctx.actorSigner.ensureKey(did)
        return ctx.actorSigner.getPublicKey(did)
      },
      createAttestation: ctx.createAttestation,
      createApprovedRoomPost: async ({ did, boundary, text }) => {
        const result = await createRecord(
          ctx,
          {
            repo: did,
            collection: 'zone.stratos.feed.post',
            record: {
              $type: 'zone.stratos.feed.post',
              text,
              boundary: {
                $type: 'zone.stratos.boundary.defs#Domains',
                values: [{ value: boundary }],
              },
              createdAt: new Date().toISOString(),
            },
          },
          did,
        )
        return { uri: result.uri, cid: result.cid }
      },
    })
    app.use('/oauth', oauthRoutes)
  }

  /**
   * Register admin OAuth authorization routes for the Stratos service.
   * @param app - Express application instance
   * @param ctx - Application context
   * @param cfg - Stratos service configuration
   * @private
   */
  private static registerAdminAuthRoutes(
    app: express.Application,
    ctx: AppContext,
    cfg: StratosServiceConfig,
  ) {
    const adminRoutes = createAdminAuthRoutes({
      // The isolated admin client: its sessions live under a separate key
      // space, so an admin login cannot overwrite the same DID's repo-write
      // enrollment session.
      oauthClient: ctx.adminOauthClient,
      adminSessionStore: ctx.adminSessionStore,
      adminUserStore: ctx.adminUserStore,
      adminDids: cfg.adminDids,
      baseUrl: cfg.service.publicUrl,
      devMode: cfg.stratos.devMode === true,
      logger: ctx.logger,
    })
    app.use('/admin', adminRoutes)
  }

  /**
   * Register feature-related routes and handlers for the Stratos service.
   * @param app - Express application instance
   * @param ctx - Application context
   * @private
   */
  private static registerFeatureHandlers(
    app: express.Application,
    ctx: AppContext,
  ) {
    registerHandlers(ctx.xrpcServer, ctx)
    registerSubscribeRecords(ctx)
    app.use(ctx.xrpcServer.router)
  }

  /**
   * Register error handling middleware for the Stratos service.
   * @param app - Express application instance
   * @param ctx - Application context
   * @param cfg - Stratos service configuration
   * @private
   */
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
        captureUnexpectedError(err)
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

    this.ctx.pdsSyncWorker.start()

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        serviceMetrics.setReady(true)
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
    serviceMetrics.setReady(false)
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
  server.ctx.logger?.info(
    {
      publicUrl: cfg.service.publicUrl,
      did: cfg.service.did,
      devMode: cfg.stratos.devMode,
    },
    'Stratos configuration',
  )

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('SIGTERM', async () => {
    server.ctx.logger?.info('SIGTERM received, shutting down...')
    await server.stop()
    await shutdownTelemetry()
    process.exit(0)
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  process.on('SIGINT', async () => {
    server.ctx.logger?.info('SIGINT received, shutting down...')
    await server.stop()
    await shutdownTelemetry()
    process.exit(0)
  })
}

// Run if executed directly
if (process.argv[1] === import.meta.url.slice(7)) {
  main().catch((err) => {
    captureUnexpectedError(err)
    console.error('Fatal error:', err)
    process.exit(1)
  })
}
