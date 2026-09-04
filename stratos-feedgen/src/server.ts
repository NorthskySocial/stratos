import type { Server as HttpServer } from 'node:http'
import express, { type Express, type RequestHandler } from 'express'
import { createServer as createXrpcServer } from '@atproto/xrpc-server'
import type { Logger } from '@northskysocial/stratos-core'
import type { FeedRequestVerifier } from './auth/index.js'
import type { FeedgenStore } from './db/index.js'
import type { EnrollmentManager } from './enrollment/index.js'
import type { FeedRegistry } from './feeds/index.js'
import {
  registerDescribeFeedHandler,
  registerGetFeedHandler,
} from './api/index.js'
import { FEEDGEN_LEXICONS } from './lexicon/index.js'
import type { FeedgenMetrics, SubscriptionStatus } from './metrics.js'
import type { FeedReadiness } from './readiness.js'
import {
  getRequestContext,
  requestIdMiddleware,
} from './middleware/request-id.js'

export interface FeedgenServerDeps {
  feedgenServiceDid: string
  /** Public base URL of this feed gen, used as the DID document service endpoint. */
  feedgenPublicUrl: string
  /** Multibase-encoded public signing key (the `did:key:` suffix). */
  publicKeyMultibase: string
  feeds: FeedRegistry
  store: FeedgenStore
  enrollmentManager: EnrollmentManager
  verifier: FeedRequestVerifier
  /** Reported by `/health`. Defaults to the package version. */
  version?: string
  /** Request-completion logger. Omitted: no request logging. */
  logger?: Logger
  /** Optional OpenTelemetry metric set. The Collector owns Prometheus export. */
  metrics?: FeedgenMetrics
  /** Late-bound subscription state reported by `/health`. */
  subscriptionStatus?: SubscriptionStatus
  /** Optional fail-closed gate for projections pending authorization replay. */
  feedReadiness?: FeedReadiness
}

export interface FeedgenHttpServer {
  app: Express
  listen: (port: number, host?: string) => Promise<HttpServer>
}

const DEFAULT_VERSION = '0.1.0'

/**
 * Build the feedgen Express app with XRPC handlers and a `/health` endpoint.
 * Caller is responsible for `app.listen(...)` (or use {@link FeedgenHttpServer.listen}).
 */
export function createFeedgenServer(
  deps: FeedgenServerDeps,
): FeedgenHttpServer {
  const xrpc = createXrpcServer(FEEDGEN_LEXICONS, { validateResponse: false })

  registerGetFeedHandler(xrpc, {
    feeds: deps.feeds,
    store: deps.store,
    enrollmentManager: deps.enrollmentManager,
    verifier: deps.verifier,
    readiness: deps.feedReadiness,
    metrics: deps.metrics,
  })

  registerDescribeFeedHandler(xrpc, {
    feedgenServiceDid: deps.feedgenServiceDid,
    feeds: deps.feeds,
  })

  const app = express()
  app.disable('x-powered-by')

  app.use(requestIdMiddleware())
  app.use(requestInstrumentation(deps))

  const version = deps.version ?? DEFAULT_VERSION
  const status = deps.subscriptionStatus
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version,
      serviceStreamConnected: status?.serviceStream?.isConnected() ?? false,
      actorPoolSize: status?.actorPool?.getStats().active ?? 0,
    })
  })

  app.get('/.well-known/did.json', (_req, res) => {
    res.json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1',
      ],
      id: deps.feedgenServiceDid,
      verificationMethod: [
        {
          id: `${deps.feedgenServiceDid}#atproto`,
          type: 'Multikey',
          controller: deps.feedgenServiceDid,
          publicKeyMultibase: deps.publicKeyMultibase,
        },
      ],
      service: [
        {
          id: '#stratos_feedgen',
          type: 'NorthskyStratosFeedGen',
          serviceEndpoint: deps.feedgenPublicUrl,
        },
      ],
    })
  })

  app.use(xrpc.router)

  return {
    app,
    listen(port, host) {
      return new Promise<HttpServer>((resolve, reject) => {
        const httpServer = app.listen(port, host ?? '0.0.0.0', () => {
          resolve(httpServer)
        })
        httpServer.once('error', reject)
      })
    },
  }
}

const KNOWN_ENDPOINTS = new Set([
  '/health',
  '/.well-known/did.json',
  ...FEEDGEN_LEXICONS.map((doc) => `/xrpc/${doc.id}`),
])

/** Endpoints that scrapes/probes hit constantly; counted but not logged. */
const UNLOGGED_ENDPOINTS = new Set(['/health'])

/**
 * Completion hook per request: one structured log line and the request
 * counter/duration metrics. The endpoint label is the route path — never the
 * raw URL — and unknown paths collapse to one label so an attacker cannot
 * inflate label cardinality.
 */
function requestInstrumentation(
  deps: Pick<FeedgenServerDeps, 'logger' | 'metrics'>,
): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint()
    const completeMetrics = deps.metrics?.beginHttpRequest()
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      const endpoint = KNOWN_ENDPOINTS.has(req.path) ? req.path : 'unknown'
      const status = res.statusCode
      completeMetrics?.({
        method: req.method,
        route: endpoint,
        status,
        durationSeconds: durationMs / 1_000,
      })
      if (deps.logger && !UNLOGGED_ENDPOINTS.has(endpoint)) {
        const ctx = getRequestContext()
        deps.logger.info(
          {
            requestId: ctx?.requestId,
            viewerDid: ctx?.viewerDid,
            endpoint,
            status,
            durationMs,
          },
          'request completed',
        )
      }
    })
    next()
  }
}
