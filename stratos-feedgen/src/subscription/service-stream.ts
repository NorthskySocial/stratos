// copied from stratos-indexer/src/sync/stratos-sync.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// Todo: extract a shared stratos-sync library used by both the indexer and feedgen
import { decodeFirst } from '@atcute/cbor'
import { StratosError } from '@northskysocial/stratos-core'
import { WebSocket as NodeWebSocket } from 'ws'

export interface ServiceStreamCallbacks {
  onEnroll: (did: string, boundaries: string[]) => void | Promise<void>
  onUnenroll: (did: string) => void | Promise<void>
  /**
   * SWP-13: an already-enrolled actor's boundary set changed. `boundaries` is
   * the set AFTER the change (`boundaries-after`); the consumer diffs it against
   * its held snapshot to purge derived state for any boundary the actor left and
   * to evict the stale viewer cache entry. Optional so existing wirings that
   * only care about enroll/unenroll need no change.
   */
  onBoundariesChanged?: (
    did: string,
    boundaries: string[],
  ) => void | Promise<void>
}

export interface ServiceStreamConfig {
  stratosServiceUrl: string
  mintToken: () => Promise<string>
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  /**
   * How long a connection must stay open before its backoff counter is reset.
   * Prevents an accept-then-immediately-close loop from reconnecting forever at
   * the base delay without ever escalating.
   */
  stabilityResetMs?: number
}

interface EnrollmentMessage {
  did: string
  action: 'enroll' | 'unenroll' | 'boundaries'
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
  close: () => void
  addEventListener: (type: 'open', cb: () => void) => void
  onmessage: ((e: MessageEventLike) => void) | null
  onerror: ((e: ErrorEventLike) => void) | null
  onclose: (() => void) | null
}

interface WebSocketConnectOptions {
  headers?: Record<string, string>
}

type WebSocketCtor = new (
  url: string,
  options?: WebSocketConnectOptions,
) => WebSocketLike

const DEFAULT_BASE_DELAY_MS = 5_000
const DEFAULT_MAX_DELAY_MS = 60_000
const DEFAULT_JITTER_RATIO = 0.2
const DEFAULT_STABILITY_RESET_MS = 30_000
const WS_OPEN = 1

/**
 * Maintains a WebSocket subscription to the Stratos service-level
 * `zone.stratos.sync.subscribeRecords` stream, dispatching enrollment and
 * unenrollment events to the supplied callbacks. Reconnects with exponential
 * backoff (5s base, 60s cap, ±20% jitter) and mints a fresh service-auth JWT
 * (sent as an `Authorization: Bearer` header on the upgrade) on every
 * (re)connect.
 */
export class ServiceStream {
  private ws: WebSocketLike | null = null
  private running = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterRatio: number
  private readonly stabilityResetMs: number
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
    this.stabilityResetMs =
      config.stabilityResetMs ?? DEFAULT_STABILITY_RESET_MS
    this.wsCtor = deps?.wsCtor ?? (NodeWebSocket as unknown as WebSocketCtor)
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
    this.clearStabilityTimer()
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

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl)

    let ws: WebSocketLike
    try {
      ws = new this.wsCtor(wsUrl, {
        headers: { authorization: `Bearer ${token}` },
      })
    } catch (err) {
      this.onError?.(err as Error)
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      this.armStabilityReset()
    })

    ws.onmessage = (e: MessageEventLike) => {
      const buf = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data)
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
      this.clearStabilityTimer()
      if (this.running) {
        this.scheduleReconnect()
      }
    }
  }

  /**
   * Reset the backoff counter only after the connection has stayed open for
   * `stabilityResetMs`. A connection that drops before then keeps its elevated
   * attempt count so repeated early failures escalate the delay.
   */
  private armStabilityReset(): void {
    this.clearStabilityTimer()
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null
      this.reconnectAttempt = 0
    }, this.stabilityResetMs)
    this.stabilityTimer.unref?.()
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return
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
      const [body] = decodeFirst(rest) as [Record<string, unknown>, Uint8Array]
      const enrollment = body as unknown as EnrollmentMessage
      switch (enrollment.action) {
        case 'enroll':
          await this.callbacks.onEnroll(
            enrollment.did,
            enrollment.boundaries ?? [],
          )
          break
        case 'unenroll':
          await this.callbacks.onUnenroll(enrollment.did)
          break
        case 'boundaries':
          // SWP-13: optional so consumers that don't track boundary changes can
          // omit it. An unknown/future action simply falls through as a no-op.
          await this.callbacks.onBoundariesChanged?.(
            enrollment.did,
            enrollment.boundaries ?? [],
          )
          break
      }
    } catch (err) {
      this.onError?.(err as Error)
    }
  }
}

function buildWsUrl(serviceUrl: string): string {
  const url = new URL(serviceUrl.replace(/^http/, 'ws'))
  url.pathname = '/xrpc/zone.stratos.sync.subscribeRecords'
  return url.toString()
}
