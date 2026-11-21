/**
 * Stratos does not serve the upstream writer-set and revocation routes. A
 * request for `com.atproto.space.listWriters`, `notifyRepoUpdate`,
 * `notifyCredentialsRevoked` or `authorizeSpaceSync` is answered as an unknown
 * method, the same as a name nobody ever defined, and the DID document offers
 * no `#atproto_pds` service that would advertise them. The routes run in the
 * in-process service with its real handlers and stores.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { StratosServer } from '../src/index.js'
import {
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const UPSTREAM_ROUTES = [
  { nsid: 'com.atproto.space.listWriters', method: 'GET' },
  { nsid: 'com.atproto.space.notifyRepoUpdate', method: 'POST' },
  { nsid: 'com.atproto.space.notifyCredentialsRevoked', method: 'POST' },
  { nsid: 'com.atproto.space.authorizeSpaceSync', method: 'POST' },
] as const

const NEVER_DEFINED = 'com.atproto.space.faye'
const UNKNOWN_METHOD = {
  status: 501,
  body: { error: 'MethodNotImplemented', message: 'Method Not Implemented' },
}

describe('upstream space routes Stratos does not serve', () => {
  let harness: WriteHarness
  const listeners: Server[] = []

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
  }, 60_000)

  afterEach(async () => {
    await Promise.all(
      listeners
        .splice(0)
        .map((listener) => new Promise((done) => listener.close(done))),
    )
  })

  afterAll(async () => {
    await harness.close()
  })

  /** The service's own router, with room for a route placed before it. */
  async function serve(
    before: (app: express.Application) => void = () => {},
  ): Promise<string> {
    const app = express()
    before(app)
    app.use(harness.ctx.xrpcServer.router)
    StratosServer['registerWellKnownRoutes'](
      app,
      harness.ctx,
      harness.ctx.cfg as never,
    )
    const listener = createServer(app)
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    )
    listeners.push(listener)
    return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  }

  async function answer(
    baseUrl: string,
    nsid: string,
    method: 'GET' | 'POST',
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}/xrpc/${nsid}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? '{}' : undefined,
    })
    return { status: response.status, body: await response.json() }
  }

  async function requireUnknownMethod(baseUrl: string): Promise<void> {
    for (const { nsid, method } of UPSTREAM_ROUTES) {
      expect(await answer(baseUrl, nsid, method), nsid).toEqual(UNKNOWN_METHOD)
    }
  }

  it.each(UPSTREAM_ROUTES)(
    'answers $nsid as an unknown method',
    async ({ nsid, method }) => {
      expect(await answer(await serve(), nsid, method)).toEqual(UNKNOWN_METHOD)
    },
  )

  it('answers them as it answers a name nobody defined', async () => {
    const baseUrl = await serve()
    expect(await answer(baseUrl, NEVER_DEFINED, 'GET')).toEqual(UNKNOWN_METHOD)
    expect(await answer(baseUrl, NEVER_DEFINED, 'POST')).toEqual(UNKNOWN_METHOD)
  })

  it('answers them as unknown whoever asks', async () => {
    const baseUrl = await serve()
    for (const { nsid, method } of UPSTREAM_ROUTES) {
      const response = await fetch(`${baseUrl}/xrpc/${nsid}`, {
        method,
        headers: {
          authorization: `Bearer ${HARNESS_SERVICE_DID}`,
          'content-type': 'application/json',
        },
        body: method === 'POST' ? '{}' : undefined,
      })
      expect(response.status, nsid).toBe(501)
    }
  })

  it('still serves the route Stratos defines for the same job', async () => {
    const response = await fetch(
      `${await serve()}/xrpc/zone.stratos.space.listRepos`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'InvalidRequest' })
  })

  it('notices a handler registered for one of the routes', async () => {
    const baseUrl = await serve((app) =>
      app.get('/xrpc/com.atproto.space.listWriters', (_req, res) => {
        res.json({ writers: [] })
      }),
    )
    await expect(requireUnknownMethod(baseUrl)).rejects.toThrow(
      'com.atproto.space.listWriters',
    )
  })

  it('offers no #atproto_pds service in the DID document', async () => {
    const response = await fetch(`${await serve()}/.well-known/did.json`)
    expect(response.status).toBe(200)
    const document = (await response.json()) as {
      service: Array<{ id: string }>
    }
    expect(document.service.length).toBeGreaterThan(0)
    expect(
      document.service.some((entry) => entry.id.endsWith('#atproto_pds')),
    ).toBe(false)
  })
})
