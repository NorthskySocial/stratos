import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildFeedRegistry,
  createFeedgenServer,
  type FeedRequestVerifier,
} from '../src/index.js'

const FEEDGEN_DID = 'did:web:feedgen.spiegelcorp.test'

async function startServer(): Promise<{
  httpServer: HttpServer
  baseUrl: string
}> {
  const feeds = buildFeedRegistry([
    {
      id: 'eng-feed',
      boundary: 'engineering',
      displayName: 'Engineering',
      description: 'Posts in engineering boundary',
    },
    { id: 'leadership-feed', boundary: 'leadership' },
  ])

  const verifier: FeedRequestVerifier = async () => ({
    viewerDid: 'did:plc:irrelevant',
    lxm: 'zone.stratos.feedgen.describeFeed',
  })

  const server = createFeedgenServer({
    feedgenServiceDid: FEEDGEN_DID,
    feeds,
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

describe('zone.stratos.feedgen.describeFeed', () => {
  let httpServer: HttpServer | undefined

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
      httpServer = undefined
    }
  })

  it('lists all configured feeds with the generator did', async () => {
    const ctx = await startServer()
    httpServer = ctx.httpServer

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.describeFeed`,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      did: string
      feeds: Array<{
        id: string
        boundary: string
        displayName?: string
        description?: string
      }>
    }
    expect(body.did).toBe(FEEDGEN_DID)
    expect(body.feeds).toHaveLength(2)
    expect(body.feeds[0]).toEqual({
      id: 'eng-feed',
      boundary: 'engineering',
      displayName: 'Engineering',
      description: 'Posts in engineering boundary',
    })
    expect(body.feeds[1]).toEqual({
      id: 'leadership-feed',
      boundary: 'leadership',
    })
  })

  it('does not require auth', async () => {
    const ctx = await startServer()
    httpServer = ctx.httpServer

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.describeFeed`,
    )

    expect(res.status).toBe(200)
  })
})
