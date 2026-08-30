import { createServer, type Server as HttpServer } from 'node:http'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@northskysocial/stratos-core'

import {
  ActorPool,
  ActorSyncer,
  createPanicHandler,
  createShutdownHandler,
  installPanicHandlers,
  installShutdownHandlers,
  SubscriptionIndexer,
} from '../src/index.js'
import type { FeedgenStore } from '../src/db/index.js'

const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

interface CapturedLine {
  level: string
  obj: Record<string, unknown>
  msg?: string
}

function captureLogger(lines: CapturedLine[]): Logger {
  const push =
    (level: string) =>
    (obj: object | string, msg?: string): void => {
      lines.push({ level, obj: obj as Record<string, unknown>, msg })
    }
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { promise, resolve }
}

/**
 * Raw HTTP GET without keep-alive so the connection closes with the response
 * and `httpServer.close()` can complete during the drain.
 */
function httpGet(
  url: string,
): Promise<{ status: number }> & { socketError: Promise<Error> } {
  let reportSocketError!: (err: Error) => void
  const socketError = new Promise<Error>((res) => (reportSocketError = res))
  const promise = new Promise<{ status: number }>((resolve, reject) => {
    const req = request(url, { agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
    })
    req.on('error', (err) => {
      reportSocketError(err)
      reject(err)
    })
    req.end()
  })
  return Object.assign(promise, { socketError })
}

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ httpServer: HttpServer; baseUrl: string }> {
  const httpServer = createServer(handler)
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  )
  const addr = httpServer.address() as AddressInfo
  return { httpServer, baseUrl: `http://127.0.0.1:${addr.port}` }
}

describe('createShutdownHandler', () => {
  it('drains an in-flight request, then stops streams, pool, and store in order', async () => {
    const events: string[] = []
    const lines: CapturedLine[] = []
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const requestReceived = deferred()
    const releaseResponse = deferred()
    const { httpServer, baseUrl } = await listen((_req, res) => {
      requestReceived.resolve()
      void releaseResponse.promise.then(() => {
        res.statusCode = 200
        res.end('ok')
      })
    })
    const poolDrain = deferred()
    const handler = createShutdownHandler({
      httpServer,
      serviceStream: {
        stop: () => {
          events.push('serviceStream.stop')
        },
      },
      actorPool: {
        stop: async () => {
          events.push('pool.stop.start')
          await poolDrain.promise
          events.push('pool.stop.end')
        },
      },
      store: {
        close: async () => {
          events.push('store.close')
        },
      },
      logger: captureLogger(lines),
      exit: vi.fn(),
    })

    const inflight = httpGet(`${baseUrl}/slow`)
    await requestReceived.promise
    clearTimeoutSpy.mockClear()
    const done = handler('SIGTERM')
    releaseResponse.resolve()

    const res = await inflight
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(events).toContain('pool.stop.start'))
    poolDrain.resolve()
    await done
    expect(events).toEqual([
      'serviceStream.stop',
      'pool.stop.start',
      'pool.stop.end',
      'store.close',
    ])
    expect(lines.filter((l) => l.level === 'warn')).toEqual([])
    const infos = lines.filter((l) => l.level === 'info')
    expect(infos.map((l) => l.msg)).toEqual([
      'shutdown started',
      'shutdown complete',
    ])
    expect(infos.every((l) => l.obj['signal'] === 'SIGTERM')).toBe(true)
    // The drain deadline timer must be cleared once the drain wins the race.
    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })

  it('destroys sockets still open at the drain deadline and exits 0', async () => {
    const lines: CapturedLine[] = []
    const requestReceived = deferred()
    const { httpServer, baseUrl } = await listen(() => {
      // Never respond: the request outlives the drain deadline.
      requestReceived.resolve()
    })
    const exit = vi.fn()
    const storeClose = vi.fn(async () => {})
    const handler = createShutdownHandler({
      httpServer,
      store: { close: storeClose },
      logger: captureLogger(lines),
      drainTimeoutMs: 50,
      exit,
    })

    const stuck = httpGet(`${baseUrl}/never`)
    stuck.catch(() => {})
    await requestReceived.promise
    await handler('SIGTERM')

    await expect(stuck).rejects.toThrow()
    expect(storeClose).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toBe(
      'drain deadline expired; destroying open connections',
    )
    expect(warns[0]?.obj['timeoutMs']).toBe(50)
  })

  it('awaits the service stream drain before closing the store', async () => {
    const events: string[] = []
    const streamDrain = deferred()
    const { httpServer } = await listen((_req, res) => res.end())
    const exit = vi.fn()
    const handler = createShutdownHandler({
      httpServer,
      serviceStream: {
        stop: () => {
          events.push('stream.stop')
          return streamDrain.promise.then(() => {
            events.push('stream.drained')
          })
        },
      },
      store: {
        close: async () => {
          events.push('store.close')
        },
      },
      logger: nullLogger,
      exit,
    })

    const done = handler('SIGTERM')
    await vi.waitFor(() => expect(events).toContain('stream.stop'))
    streamDrain.resolve()
    await done

    expect(events).toEqual(['stream.stop', 'stream.drained', 'store.close'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('continues shutdown when the service stream drain misses the deadline', async () => {
    const lines: CapturedLine[] = []
    const { httpServer } = await listen((_req, res) => res.end())
    const exit = vi.fn()
    const storeClose = vi.fn(async () => {})
    const handler = createShutdownHandler({
      httpServer,
      serviceStream: {
        stop: () => new Promise<void>(() => {}),
      },
      store: { close: storeClose },
      logger: captureLogger(lines),
      drainTimeoutMs: 50,
      exit,
    })

    await handler('SIGTERM')

    expect(storeClose).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toBe(
      'service stream drain deadline expired; continuing shutdown',
    )
    expect(warns[0]?.obj['timeoutMs']).toBe(50)
  })

  it('waits for in-flight startup before stopping the stream and closing the store', async () => {
    const events: string[] = []
    const startupGate = deferred()
    const exit = vi.fn()
    const deps: Parameters<typeof createShutdownHandler>[0] = {
      logger: nullLogger,
      exit,
      store: {
        close: async () => {
          events.push('store.close')
        },
      },
    }
    deps.startup = startupGate.promise.then(() => {
      // Startup finishes during the wait and publishes the stream it created.
      deps.serviceStream = {
        stop: () => {
          events.push('stream.stop')
        },
      }
      events.push('startup.settled')
    })
    const handler = createShutdownHandler(deps)

    const done = handler('SIGTERM')
    await new Promise((res) => setTimeout(res, 10))
    expect(events).toEqual([])
    startupGate.resolve()
    await done

    expect(events).toEqual(['startup.settled', 'stream.stop', 'store.close'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('continues shutdown when startup misses the deadline', async () => {
    const lines: CapturedLine[] = []
    const exit = vi.fn()
    const storeClose = vi.fn(async () => {})
    const handler = createShutdownHandler({
      startup: new Promise<void>(() => {}),
      store: { close: storeClose },
      logger: captureLogger(lines),
      drainTimeoutMs: 50,
      exit,
    })

    await handler('SIGTERM')

    expect(storeClose).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toBe(
      'startup drain deadline expired; continuing shutdown',
    )
    expect(warns[0]?.obj['timeoutMs']).toBe(50)
  })

  it('awaits the in-flight commit apply so the cursor lands before the DB closes', async () => {
    const events: string[] = []
    const applyGate = deferred()
    const store = {
      getCursor: async () => null,
      upsertPost: async () => {
        await applyGate.promise
      },
      upsertCursor: async () => {
        events.push('upsertCursor')
      },
      deletePost: async () => {},
    } as unknown as FeedgenStore

    class FakeWs {
      static instances: FakeWs[] = []
      readyState = 1
      binaryType = ''
      onmessage: ((e: { data: Uint8Array }) => void) | null = null
      onerror: ((e: Event) => void) | null = null
      onclose: (() => void) | null = null
      constructor() {
        FakeWs.instances.push(this)
      }
      addEventListener(): void {}
      close(): void {}
    }

    const pool = new ActorPool(
      {
        stratosServiceUrl: 'http://stratos.mars.test',
        mintToken: async () => 'tok',
        connectDelayMs: 0,
        idleEvictionMs: 0,
      },
      {
        store,
        indexer: new SubscriptionIndexer(store),
        syncerFactory: (config, deps) =>
          new ActorSyncer(config, { ...deps, wsCtor: FakeWs as never }),
      },
    )
    pool.start()
    pool.addActor('did:plc:edwardwong')
    await vi.waitFor(() => expect(FakeWs.instances.length).toBe(1))

    const { encode } = await import('@atcute/cbor')
    const header = encode({ op: 1, t: '#commit' })
    const body = encode({
      seq: 1,
      time: '2024-01-01T00:00:00.000Z',
      ops: [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/tomato1',
          cid: 'bafy1',
          record: { $type: 'zone.stratos.feed.post', text: 'radical' },
        },
      ],
    })
    const frame = new Uint8Array(header.length + body.length)
    frame.set(header, 0)
    frame.set(body, header.length)
    FakeWs.instances[0]?.onmessage?.({ data: frame })

    const { httpServer } = await listen((_req, res) => res.end())
    const exit = vi.fn()
    const handler = createShutdownHandler({
      httpServer,
      actorPool: pool,
      store: {
        close: async () => {
          events.push('store.close')
        },
      },
      logger: nullLogger,
      exit,
    })

    const done = handler('SIGTERM')
    applyGate.resolve()
    await done

    expect(events).toEqual(['upsertCursor', 'store.close'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('completes with only a logger when no resources exist yet', async () => {
    const lines: CapturedLine[] = []
    const exit = vi.fn()
    const handler = createShutdownHandler({
      logger: captureLogger(lines),
      exit,
    })

    await handler('SIGTERM')

    expect(exit).toHaveBeenCalledWith(0)
    expect(lines.filter((l) => l.level === 'error')).toEqual([])
    expect(lines.filter((l) => l.level === 'info').map((l) => l.msg)).toEqual([
      'shutdown started',
      'shutdown complete',
    ])
  })

  it('drains deps assigned after the handler was created', async () => {
    const events: string[] = []
    const exit = vi.fn()
    const deps: Parameters<typeof createShutdownHandler>[0] = {
      logger: nullLogger,
      exit,
    }
    const handler = createShutdownHandler(deps)
    // Startup fills deps after the handler is installed.
    deps.store = {
      close: async () => {
        events.push('store.close')
      },
    }
    deps.serviceStream = {
      stop: () => {
        events.push('stream.stop')
      },
    }

    await handler('SIGTERM')

    expect(events).toEqual(['stream.stop', 'store.close'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits 1 immediately on a second signal', async () => {
    const lines: CapturedLine[] = []
    const { httpServer } = await listen((_req, res) => res.end())
    const exit = vi.fn()
    const poolDrain = deferred()
    const storeClose = vi.fn(async () => {})
    const handler = createShutdownHandler({
      httpServer,
      actorPool: { stop: () => poolDrain.promise },
      store: { close: storeClose },
      logger: captureLogger(lines),
      exit,
    })

    const first = handler('SIGTERM')
    await handler('SIGINT')
    expect(exit).toHaveBeenCalledWith(1)
    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toBe('second shutdown signal; forcing exit')
    expect(warns[0]?.obj['signal']).toBe('SIGINT')

    poolDrain.resolve()
    await first
    expect(exit).toHaveBeenLastCalledWith(0)
    expect(storeClose).toHaveBeenCalledTimes(1)
    expect(lines.filter((l) => l.level === 'error')).toEqual([])
  })

  it('exits 1 when a shutdown step fails', async () => {
    const lines: CapturedLine[] = []
    const { httpServer } = await listen((_req, res) => res.end())
    const exit = vi.fn()
    const handler = createShutdownHandler({
      httpServer,
      store: {
        close: async () => {
          throw new Error('sqlite is on fire')
        },
      },
      logger: captureLogger(lines),
      exit,
    })

    await handler('SIGTERM')
    expect(exit).toHaveBeenCalledWith(1)
    const errors = lines.filter((l) => l.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.msg).toBe('shutdown failed')
    expect((errors[0]?.obj['err'] as Error).message).toBe('sqlite is on fire')
  })

  it('falls back to process.exit when no exit override is given', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
    try {
      const { httpServer } = await listen((_req, res) => res.end())
      const handler = createShutdownHandler({
        httpServer,
        store: {
          close: async () => {
            throw new Error('gate network offline')
          },
        },
        logger: nullLogger,
      })
      await handler('SIGTERM')
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('installShutdownHandlers registers SIGTERM and SIGINT listeners that run the handler', async () => {
    const lines: CapturedLine[] = []
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(
        (event: string | symbol, listener: (...args: unknown[]) => void) => {
          registered.set(String(event), listener)
          return process
        },
      )
    try {
      const { httpServer } = await listen((_req, res) => res.end())
      const exit = vi.fn()
      installShutdownHandlers({
        httpServer,
        store: { close: async () => {} },
        logger: captureLogger(lines),
        exit,
      })
      expect([...registered.keys()]).toEqual(['SIGTERM', 'SIGINT'])

      registered.get('SIGTERM')?.()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
      expect(
        lines.some(
          (l) => l.msg === 'shutdown started' && l.obj['signal'] === 'SIGTERM',
        ),
      ).toBe(true)

      registered.get('SIGINT')?.()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
      expect(
        lines.some(
          (l) =>
            l.msg === 'second shutdown signal; forcing exit' &&
            l.obj['signal'] === 'SIGINT',
        ),
      ).toBe(true)
    } finally {
      onSpy.mockRestore()
    }
  })
})

describe('createPanicHandler', () => {
  it('logs the fatal error and exits 1', () => {
    const lines: CapturedLine[] = []
    const exit = vi.fn()
    const handler = createPanicHandler(captureLogger(lines), exit)

    handler(new Error('angel attack'))

    expect(lines).toHaveLength(1)
    expect(lines[0]?.msg).toBe('unrecoverable error; exiting')
    expect((lines[0]?.obj['err'] as Error).message).toBe('angel attack')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('defaults to process.exit', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
    try {
      createPanicHandler(nullLogger)(new Error('eva unit berserk'))
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('installPanicHandlers registers unhandledRejection and uncaughtException', () => {
    const lines: CapturedLine[] = []
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(
        (event: string | symbol, listener: (...args: unknown[]) => void) => {
          registered.set(String(event), listener)
          return process
        },
      )
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
    try {
      installPanicHandlers(captureLogger(lines))
      expect([...registered.keys()]).toEqual([
        'unhandledRejection',
        'uncaughtException',
      ])
      registered.get('uncaughtException')?.(new Error('terminal dogma breach'))
      expect(lines[0]?.msg).toBe('unrecoverable error; exiting')
      expect(exitSpy).toHaveBeenCalledWith(1)
    } finally {
      onSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })
})
