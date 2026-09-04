import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '@northskysocial/stratos-core'

import {
  buildFeedRegistry,
  createFeedgenServer,
  sanitizeRequestId,
  type FeedRequestVerifier,
} from '../src/index.js'
import { toXrpcAuthVerifier } from '../src/api/util.js'

const FEEDGEN_DID = 'did:web:feedgen.mars.test'
const VIEWER_DID = 'did:plc:jetblack'
const SECRET_TOKEN = 'Bearer swordfish-ii-secret'

interface CapturedLine {
  level: string
  obj: object | string
  msg?: string
}

function captureLogger(lines: CapturedLine[]): Logger {
  const push =
    (level: string) =>
    (obj: object | string, msg?: string): void => {
      lines.push({ level, obj, msg })
    }
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

interface TestServerCtx {
  httpServer: HttpServer
  baseUrl: string
  lines: CapturedLine[]
}

async function startServer(opts?: {
  listPosts?: () => Promise<never>
}): Promise<TestServerCtx> {
  const lines: CapturedLine[] = []
  const verifier: FeedRequestVerifier = async () => ({
    viewerDid: VIEWER_DID,
    lxm: 'zone.stratos.feedgen.getFeed',
  })
  const feeds = buildFeedRegistry([{ id: 'bebop-feed', boundary: 'bebop' }])

  const server = createFeedgenServer({
    feedgenServiceDid: FEEDGEN_DID,
    feedgenPublicUrl: 'https://feedgen.mars.test',
    publicKeyMultibase: 'zQ3shFakeMultibaseForTests',
    feeds,
    store: {
      listPostsByBoundary:
        opts?.listPosts ?? (async () => ({ posts: [] as never[] })),
    } as unknown as Parameters<typeof createFeedgenServer>[0]['store'],
    enrollmentManager: {
      getBoundaries: async () => ['bebop'],
    } as unknown as Parameters<
      typeof createFeedgenServer
    >[0]['enrollmentManager'],
    verifier,
    logger: captureLogger(lines),
  })

  const httpServer = await server.listen(0, '127.0.0.1')
  const addr = httpServer.address() as AddressInfo
  return { httpServer, baseUrl: `http://127.0.0.1:${addr.port}`, lines }
}

async function stopServer(ctx: TestServerCtx): Promise<void> {
  await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()))
}

function completionLines(ctx: TestServerCtx): Array<Record<string, unknown>> {
  return ctx.lines
    .filter((l) => l.msg === 'request completed')
    .map((l) => l.obj as Record<string, unknown>)
}

describe('request completion logging', () => {
  let ctx: TestServerCtx | undefined

  afterEach(async () => {
    if (ctx) await stopServer(ctx)
    ctx = undefined
  })

  it('logs requestId, viewerDid, endpoint, status, and durationMs', async () => {
    ctx = await startServer()

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop-feed`,
      { headers: { authorization: SECRET_TOKEN } },
    )
    expect(res.status).toBe(200)

    const entries = completionLines(ctx)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(typeof entry?.['requestId']).toBe('string')
    expect(entry?.['viewerDid']).toBe(VIEWER_DID)
    expect(entry?.['endpoint']).toBe('/xrpc/zone.stratos.feedgen.getFeed')
    expect(entry?.['status']).toBe(200)
    expect(entry?.['durationMs']).toBeGreaterThanOrEqual(0)
    expect(entry?.['durationMs']).toBeLessThan(60_000)
  })

  it('labels /.well-known/did.json with its route path, not unknown', async () => {
    ctx = await startServer()

    await fetch(`${ctx.baseUrl}/.well-known/did.json`)
    expect(completionLines(ctx)[0]?.['endpoint']).toBe('/.well-known/did.json')
  })

  it('honors an inbound X-Request-Id and echoes it back', async () => {
    ctx = await startServer()

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop-feed`,
      {
        headers: {
          authorization: SECRET_TOKEN,
          'x-request-id': 'bebop-42',
        },
      },
    )

    expect(res.headers.get('x-request-id')).toBe('bebop-42')
    expect(completionLines(ctx)[0]?.['requestId']).toBe('bebop-42')
  })

  it('sanitizes a hostile X-Request-Id before echo and log', async () => {
    ctx = await startServer()

    const res = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop-feed`,
      {
        headers: {
          authorization: SECRET_TOKEN,
          'x-request-id': 'ein{corgi}\t!' + 'a'.repeat(100),
        },
      },
    )

    const echoed = res.headers.get('x-request-id') ?? ''
    expect(echoed).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(echoed.length).toBeLessThanOrEqual(64)
    expect(completionLines(ctx)[0]?.['requestId']).toBe(echoed)
  })

  it('returns 500 on a handler crash and keeps serving', async () => {
    ctx = await startServer({
      listPosts: async () => {
        throw new Error('hyperspace gate collapsed')
      },
    })

    const crashed = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop-feed`,
      { headers: { authorization: SECRET_TOKEN } },
    )
    expect(crashed.status).toBe(500)
    expect(completionLines(ctx)[0]?.['status']).toBe(500)

    const followUp = await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.describeFeed`,
    )
    expect(followUp.status).toBe(200)
  })

  it('never logs authorization material', async () => {
    ctx = await startServer()

    await fetch(
      `${ctx.baseUrl}/xrpc/zone.stratos.feedgen.getFeed?feed=bebop-feed`,
      { headers: { authorization: SECRET_TOKEN } },
    )

    const serialized = JSON.stringify(ctx.lines)
    expect(serialized).not.toContain('swordfish-ii-secret')
    expect(serialized.toLowerCase()).not.toContain('bearer')
  })

  it('does not log /health, while unknown requests retain a bounded log label', async () => {
    ctx = await startServer()

    await fetch(`${ctx.baseUrl}/health`)
    await fetch(`${ctx.baseUrl}/metrics`)
    expect(completionLines(ctx)).toHaveLength(1)
    expect(completionLines(ctx)[0]).toMatchObject({
      endpoint: 'unknown',
      status: 404,
    })
  })

  it('reports degraded /health and no /metrics route without observability wiring', async () => {
    ctx = await startServer()

    const health = await fetch(`${ctx.baseUrl}/health`)
    expect(await health.json()).toMatchObject({
      ok: true,
      serviceStreamConnected: false,
      actorPoolSize: 0,
    })
    const metricsRes = await fetch(`${ctx.baseUrl}/metrics`)
    expect(metricsRes.status).toBe(404)
  })
})

describe('sanitizeRequestId', () => {
  it('returns undefined when nothing safe remains', () => {
    expect(sanitizeRequestId('{}\t!?')).toBeUndefined()
    expect(sanitizeRequestId('')).toBeUndefined()
  })
})

describe('toXrpcAuthVerifier', () => {
  it('verifies outside an ambient request context', async () => {
    const verify = toXrpcAuthVerifier(async () => ({
      viewerDid: VIEWER_DID,
      lxm: 'zone.stratos.feedgen.getFeed',
    }))

    const result = await verify({ req: { headers: {} } } as never)
    expect(result).toEqual({
      credentials: {
        viewerDid: VIEWER_DID,
        lxm: 'zone.stratos.feedgen.getFeed',
      },
    })
  })
})
