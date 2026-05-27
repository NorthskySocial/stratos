// copied from stratos-indexer/src/sync/stratos-sync.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// Todo: extract a shared stratos-sync library used by both the indexer and feedgen
import { decodeFirst } from '@atcute/cbor'
import { StratosError } from '@northskysocial/stratos-core'

export interface ServiceStreamCallbacks {
  onEnroll: (did: string, boundaries: string[]) => void | Promise<void>
  onUnenroll: (did: string) => void | Promise<void>
}

export interface ServiceStreamConfig {
  stratosServiceUrl: string
  mintToken: () => Promise<string>
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

interface EnrollmentMessage {
  did: string
  action: 'enroll' | 'unenroll'
  service?: string
  boundaries?: string[]
  time: string
}

interface MessageEventLike {
  data: ArrayBuffer | Uint8Array
}

interface ErrorEventLike extends Event {
  error?: unknown
  message?: string
}

interface WebSocketLike {
  readyState: number
  binaryType: string
  close(): void
  addEventListener(type: 'open', cb: () => void): void
  onmessage: ((e: MessageEventLike) => void) | null
  onerror: ((e: ErrorEventLike) => void) | null
  onclose: (() => void) | null
}

type WebSocketCtor = new (url: string) => WebSocketLike

const DEFAULT_BASE_DELAY_MS = 5_000
const DEFAULT_MAX_DELAY_MS = 60_000
const DEFAULT_JITTER_RATIO = 0.2
const WS_OPEN = 1

/**
 * Maintains a WebSocket subscription to the Stratos service-level
 * `zone.stratos.sync.subscribeRecords` stream, dispatching enrollment and
 * unenrollment events to the supplied callbacks. Reconnects with exponential
 * backoff (5s base, 60s cap, ±20% jitter) and mints a fresh sync token on
 * every (re)connect.
 */
export class ServiceStream {
  private ws: WebSocketLike | null = null
  private running = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterRatio: number
  private readonly wsCtor: WebSocketCtor
  private readonly rng: () => number

  constructor(
    private config: ServiceStreamConfig,
    private callbacks: ServiceStreamCallbacks,
    private onError?: (err: Error) => void,
    deps?: { wsCtor?: WebSocketCtor; rng?: () => number },
  ) {
    this.baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.jitterRatio = config.jitterRatio ?? DEFAULT_JITTER_RATIO
    this.wsCtor =
      deps?.wsCtor ?? (globalThis.WebSocket as unknown as WebSocketCtor)
    this.rng = deps?.rng ?? Math.random
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.connect()
  }

  stop(): void {
    this.running = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore close errors
      }
      this.ws = null
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return
    let token: string
    try {
      token = await this.config.mintToken()
    } catch (err) {
      this.onError?.(err as Error)
      this.scheduleReconnect()
      return
    }
    if (!this.running) return

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl, {
      syncToken: token,
    })

    let ws: WebSocketLike
    try {
      ws = new this.wsCtor(wsUrl)
    } catch (err) {
      this.onError?.(err as Error)
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0
    })

    ws.onmessage = (e: MessageEventLike) => {
      const buf =
        e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data)
      void this.handleMessage(buf)
    }

    ws.onerror = (e: ErrorEventLike) => {
      const errorMsg =
        e.error instanceof Error
          ? e.error.message
          : typeof e.error === 'string'
            ? e.error
            : (e.message ?? 'unknown')
      const cause = e.error instanceof Error ? e.error : undefined
      this.onError?.(
        new StratosError(
          `Enrollment stream error: ${errorMsg}`,
          'SUBSCRIPTION_ERROR',
          { cause },
        ),
      )
    }

    ws.onclose = () => {
      this.ws = null
      if (this.running) {
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return
    this.reconnectAttempt++
    const exp = this.baseDelayMs * Math.pow(2, this.reconnectAttempt - 1)
    const capped = Math.min(exp, this.maxDelayMs)
    const jitter = capped * this.jitterRatio * (this.rng() * 2 - 1)
    const delay = Math.max(0, Math.round(capped + jitter))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async handleMessage(data: Uint8Array): Promise<void> {
    try {
      // atproto subscription framing: two concatenated DAG-CBOR values, the
      // first being a header `{op, t}` and the second being the body.
      const [header, rest] = decodeFirst(data) as [
        Record<string, unknown>,
        Uint8Array,
      ]
      if (header['t'] !== '#enrollment') return
      const [body] = decodeFirst(rest) as [
        Record<string, unknown>,
        Uint8Array,
      ]
      const enrollment = body as unknown as EnrollmentMessage
      if (enrollment.action === 'enroll') {
        await this.callbacks.onEnroll(
          enrollment.did,
          enrollment.boundaries ?? [],
        )
      } else if (enrollment.action === 'unenroll') {
        await this.callbacks.onUnenroll(enrollment.did)
      }
    } catch (err) {
      this.onError?.(err as Error)
    }
  }
}

function buildWsUrl(
  serviceUrl: string,
  params: Record<string, string>,
): string {
  const url = new URL(serviceUrl.replace(/^http/, 'ws'))
  url.pathname = '/xrpc/zone.stratos.sync.subscribeRecords'
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}
