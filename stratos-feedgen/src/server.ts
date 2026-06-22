import type { Server as HttpServer } from 'node:http'
import express, { type Express } from 'express'
import { createServer as createXrpcServer } from '@atproto/xrpc-server'
import type { FeedRequestVerifier } from './auth/index.js'
import type { FeedgenStore } from './db/index.js'
import type { EnrollmentManager } from './enrollment/index.js'
import type { FeedRegistry } from './feeds/index.js'
import {
  registerDescribeFeedHandler,
  registerGetFeedHandler,
} from './api/index.js'
import { FEEDGEN_LEXICONS } from './lexicon/index.js'

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
  })

  registerDescribeFeedHandler(xrpc, {
    feedgenServiceDid: deps.feedgenServiceDid,
    feeds: deps.feeds,
  })

  const app = express()
  app.disable('x-powered-by')

  const version = deps.version ?? DEFAULT_VERSION
  app.get('/health', (_req, res) => {
    res.json({ ok: true, version })
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
