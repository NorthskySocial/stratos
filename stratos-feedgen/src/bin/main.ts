#!/usr/bin/env node
import { IdResolver } from '@atproto/identity'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createFeedRequestVerifier } from '../auth/index.js'
import { loadFeedgenConfig } from '../config.js'
import { createFeedgenStore } from '../db/index.js'
import { EnrollmentManager } from '../enrollment/index.js'
import { loadFeedRegistry } from '../feeds/index.js'
import { createFeedgenServer } from '../server.js'
import { ServiceStream } from '../subscription/index.js'
import { UpstreamStratosClient } from '../upstream/index.js'

async function main(): Promise<void> {
  const cfg = loadFeedgenConfig()
  const feeds = loadFeedRegistry()
  const port = parsePort(process.env['FEEDGEN_PORT']) ?? 3000

  const keypair = await Secp256k1Keypair.import(cfg.feedgenSigningKey)
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
    feeds,
    store,
    enrollmentManager,
    verifier,
  })

  const httpServer = await server.listen(port)
  console.log(`stratos-feedgen listening on :${port}`)

  const subscribeEnrollments =
    process.env['FEEDGEN_SUBSCRIBE_ENROLLMENTS'] !== 'false'
  let serviceStream: ServiceStream | null = null
  if (subscribeEnrollments) {
    serviceStream = new ServiceStream(
      {
        stratosServiceUrl: cfg.stratosServiceUrl,
        mintToken: () => upstream.mintSyncToken(),
      },
      {
        onEnroll: async (did, boundaries) => {
          const now = new Date().toISOString()
          const existing = await store.getEnrolledActor(did)
          await store.upsertEnrolledActor({
            did,
            boundaries,
            enrolledAt: existing?.enrolledAt ?? now,
            lastSeenAt: now,
          })
        },
        onUnenroll: async (did) => {
          await store.deleteEnrolledActor(did)
        },
      },
      (err) => {
        console.error('service stream error:', err)
      },
    )
    serviceStream.start()
    console.log('service enrollment subscription started')
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`received ${signal}, shutting down`)
    serviceStream?.stop()
    httpServer.close()
    store.close().then(
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

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid FEEDGEN_PORT: ${value}`)
  }
  return n
}

main().catch((err: unknown) => {
  console.error('fatal:', err)
  process.exit(1)
})
