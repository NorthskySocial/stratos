import http from 'node:http'
import express from 'express'
import cors from 'cors'
import { decode as cborDecode } from '@atproto/lex-cbor'
import { isTypedLexMap } from '@atproto/lex-data'
import type { BlobStoreCreator, Logger } from '@northskysocial/stratos-core'

import {
  type AppContext,
  createAppContext,
  destroyAppContext,
} from './context.js'
import { createLogger } from './logger.js'
import { type StratosServiceConfig, envToConfig, parseEnv } from './config.js'
import { registerHandlers } from './api/handlers.js'
import { registerSubscribeRecords } from './subscription/index.js'
import { createOAuthRoutes } from './oauth/routes.js'
import { DiskBlobStore, S3BlobStoreAdapter } from './blobstore/index.js'
import { registerEnrollmentHandlers } from './features/index.js'

export { type StratosServiceConfig, type AppContext }
export { DiskBlobStore, S3BlobStoreAdapter } from './blobstore/index.js'

/**
 * Stratos service server
 */
export class StratosServer {
  public ctx: AppContext
  public server: http.Server

  constructor(ctx: AppContext, server: http.Server) {
    this.ctx = ctx
    this.server = server
  }

  /**
   * Create and start the Stratos server
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
    app.use(cors())
    // Exclude /xrpc/ routes from express.json() - xrpc-server handles its own body parsing
    app.use((req, res, next) => {
      if (req.path.startsWith('/xrpc/')) {
        return next()
      }
      express.json({ limit: '100kb' })(req, res, next)
    })

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', version: '0.1.0' })
    })

    app.get('/.well-known/did.json', (_req, res) => {
      const serviceDid = ctx.serviceDid
      const serviceEndpoint = cfg.service.publicUrl

      res.json({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: serviceDid,
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
      if (!ctx.oauthClient) {
        return res.status(404).json({ error: 'OAuth not configured' })
      }
      res.json(ctx.oauthClient.clientMetadata)
    }

    app.get('/client-metadata.json', metadataHandler)
    app.get('/.well-known/oauth-client-metadata.json', metadataHandler)

    if (ctx.oauthClient) {
      const oauthRoutes = createOAuthRoutes({
        oauthClient: ctx.oauthClient,
        enrollmentConfig: cfg.enrollment,
        enrollmentStore: ctx.enrollmentStore,
        idResolver: ctx.idResolver,
        baseUrl: cfg.service.publicUrl,
        serviceEndpoint: cfg.service.publicUrl,
        defaultBoundaries: cfg.stratos.allowedDomains,
        logger: ctx.logger,
      })
      app.use('/oauth', oauthRoutes)
    }

    registerHandlers(ctx.xrpcServer, ctx)
    registerEnrollmentHandlers(app, ctx)
    registerSubscribeRecords(ctx)
    app.use(ctx.xrpcServer.router)

    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction,
      ) => {
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

    const server = http.createServer(app)

    // WebSocket handling is set up automatically when xrpcServer.router is mounted on app

    return new StratosServer(ctx, server)
  }

  /**
   * Start listening on configured port
   */
  async start(): Promise<void> {
    const port = this.ctx.cfg.service.port

    return new Promise((resolve) => {
      this.server.listen(port, () => {
        this.ctx.logger?.info({ port }, 'stratos server started')
        resolve()
      })
    })
  }

  /**
   * Gracefully stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(async (err) => {
        if (err) {
          reject(err)
          return
        }

        try {
          await destroyAppContext(this.ctx)
          resolve()
        } catch (cleanupErr) {
          reject(cleanupErr)
        }
      })
    })
  }
}

/**
 * Create blobstore factory from config
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

  process.on('SIGTERM', async () => {
    server.ctx.logger?.info('SIGTERM received, shutting down...')
    await server.stop()
    process.exit(0)
  })

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
