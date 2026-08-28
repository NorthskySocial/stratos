import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'

import {
  buildFeedRegistry,
  createFeedgenServer,
  loadFeedgenConfig,
  type FeedRequestVerifier,
} from '../src/index.js'

const FEEDGEN_DID = 'did:web:feedgen.spiegelcorp.test'
const PUBLIC_URL = 'https://feedgen.spiegelcorp.test'

async function startServer(publicKeyMultibase: string): Promise<{
  httpServer: HttpServer
  baseUrl: string
}> {
  const verifier: FeedRequestVerifier = async () => ({
    viewerDid: 'did:plc:irrelevant',
    lxm: 'zone.stratos.feedgen.getFeed',
  })

  const server = createFeedgenServer({
    feedgenServiceDid: FEEDGEN_DID,
    feedgenPublicUrl: PUBLIC_URL,
    publicKeyMultibase,
    feeds: buildFeedRegistry([{ id: 'eng-feed', boundary: 'engineering' }]),
    store: {
      listPostsByBoundary: async () => ({ posts: [] }),
    } as unknown as Parameters<typeof createFeedgenServer>[0]['store'],
    enrollmentManager: {
      getBoundaries: async () => [],
    } as unknown as Parameters<
      typeof createFeedgenServer
    >[0]['enrollmentManager'],
    verifier,
  })

  const httpServer = await server.listen(0, '127.0.0.1')
  const addr = httpServer.address() as AddressInfo
  return { httpServer, baseUrl: `http://127.0.0.1:${addr.port}` }
}

describe('GET /.well-known/did.json', () => {
  let httpServer: HttpServer | undefined

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
      httpServer = undefined
    }
  })

  it('serves a did:web document with the feedgen service entry', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const multibase = keypair.did().slice('did:key:'.length)

    const ctx = await startServer(multibase)
    httpServer = ctx.httpServer

    const res = await fetch(`${ctx.baseUrl}/.well-known/did.json`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      id: string
      verificationMethod: Array<{
        id: string
        type: string
        controller: string
        publicKeyMultibase: string
      }>
      service: Array<{ id: string; type: string; serviceEndpoint: string }>
    }

    expect(body.id).toBe(FEEDGEN_DID)
    expect(body.verificationMethod[0]).toEqual({
      id: `${FEEDGEN_DID}#atproto`,
      type: 'Multikey',
      controller: FEEDGEN_DID,
      publicKeyMultibase: multibase,
    })
    expect(body.service[0]).toEqual({
      id: '#stratos_feedgen',
      type: 'NorthskyStratosFeedGen',
      serviceEndpoint: PUBLIC_URL,
    })
  })
})

describe('loadFeedgenConfig public URL derivation', () => {
  const baseEnv = {
    FEEDGEN_SERVICE_DID: FEEDGEN_DID,
    FEEDGEN_SIGNING_KEY: 'unused-by-this-test',
    STRATOS_SERVICE_URL: 'https://stratos.spiegelcorp.test',
    STRATOS_SERVICE_DID: 'did:web:stratos.spiegelcorp.test',
    FEEDGEN_SQLITE_PATH: '/tmp/feedgen.sqlite',
  }

  it('derives the public URL from the did:web DID when unset', () => {
    const cfg = loadFeedgenConfig({ ...baseEnv })
    expect(cfg.feedgenPublicUrl).toBe(PUBLIC_URL)
  })

  it('prefers FEEDGEN_PUBLIC_URL when set', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      FEEDGEN_PUBLIC_URL: 'https://feeds.example.com/',
    })
    expect(cfg.feedgenPublicUrl).toBe('https://feeds.example.com')
  })

  it('defaults stratosPublicUrl to STRATOS_SERVICE_URL when unset', () => {
    const cfg = loadFeedgenConfig({ ...baseEnv })
    expect(cfg.stratosPublicUrl).toBe('https://stratos.spiegelcorp.test')
  })

  it('prefers STRATOS_PUBLIC_URL when set, independent of the internal STRATOS_SERVICE_URL', () => {
    const cfg = loadFeedgenConfig({
      ...baseEnv,
      STRATOS_SERVICE_URL: 'http://internal.stratos.local:3100',
      STRATOS_PUBLIC_URL: 'https://stratos.spiegelcorp.test/',
    })
    expect(cfg.stratosServiceUrl).toBe('http://internal.stratos.local:3100')
    expect(cfg.stratosPublicUrl).toBe('https://stratos.spiegelcorp.test')
  })
})
