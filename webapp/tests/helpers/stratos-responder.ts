import { vi } from 'vitest'

// This tsconfig leaves out @types/node on purpose, so the few members used are typed here.
interface HttpRequest {
  method?: string
  url?: string
  on(event: 'data', listener: (chunk: Uint8Array) => void): void
  on(event: 'end', listener: () => void): void
}

interface HttpResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

interface HttpServer {
  listen(port: number, host: string, onListening: () => void): void
  address(): { port: number } | string | null
  close(onClosed: () => void): void
}

interface NodeHttp {
  createServer(
    handler: (req: HttpRequest, res: HttpResponse) => void,
  ): HttpServer
}

// The webapp's vite config replaces an imported node:http with a browser shim that cannot listen.
const nodeHttp = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: string): unknown }
  }
).process.getBuiltinModule('node:http') as NodeHttp

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

export interface StratosResponder {
  /** The loopback origin the server listens on. */
  origin: string
  requests: RecordedRequest[]
  respondWith(status: number, body: unknown): void
  /** Answers the next request only; later requests get the standing reply. */
  respondOnceWith(
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void
  /** An OAuth-session stand-in whose requests to the Stratos origin reach this responder. */
  session(did: string, stratosOrigin: string): ResponderSession
  stop(): Promise<void>
}

export interface ResponderSession {
  sub: string
  did: string
  getTokenInfo: ReturnType<typeof vi.fn>
  fetchHandler: ReturnType<typeof vi.fn>
}

/** A real HTTP server on a free loopback port, so helper requests go over the wire. */
export async function startStratosResponder(): Promise<StratosResponder> {
  const requests: RecordedRequest[] = []
  let reply = { status: 200, body: {} as unknown }
  const once: Array<{
    status: number
    body: unknown
    headers: Record<string, string>
  }> = []

  const server = nodeHttp.createServer((req, res) => {
    const decoder = new TextDecoder()
    let raw = ''
    req.on('data', (chunk) => {
      raw += decoder.decode(chunk, { stream: true })
    })
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      const next = once.shift()
      res.writeHead(next?.status ?? reply.status, {
        'content-type': 'application/json',
        ...next?.headers,
      })
      res.end(JSON.stringify(next ? next.body : reply.body))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  return {
    origin,
    requests,
    respondWith(status, body) {
      reply = { status, body }
    },
    respondOnceWith(status, body, headers = {}) {
      once.push({ status, body, headers })
    },
    session(did, stratosOrigin) {
      return {
        sub: did,
        did,
        getTokenInfo: vi.fn().mockResolvedValue({ scope: '' }),
        fetchHandler: vi.fn((url: string, init?: RequestInit) =>
          fetch(url.replace(stratosOrigin, origin), init),
        ),
      }
    },
    stop: () => new Promise<void>((done) => server.close(() => done())),
  }
}
