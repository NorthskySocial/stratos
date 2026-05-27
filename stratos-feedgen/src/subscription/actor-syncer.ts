// copied from stratos-indexer/src/sync/actor-syncer.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// Todo: extract a shared stratos-sync library used by both the indexer and feedgen
import { decodeFirst } from '@atcute/cbor'
import { StratosError } from '@northskysocial/stratos-core'
import type { FeedgenStore } from '../db/index.js'
import type { CommitOp, SubscriptionIndexer } from './indexer.js'

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

type WebSocketCtor = new (url: string) => WebSocketLike

export interface ActorSyncerConfig {
  did: string
  stratosServiceUrl: string
  mintToken: () => Promise<string>
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  maxQueueSize?: number
}

export interface ActorSyncerDeps {
  store: Pick<FeedgenStore, 'getCursor'>
  indexer: SubscriptionIndexer
  onError?: (err: Error) => void
  wsCtor?: WebSocketCtor
  rng?: () => number
}

interface CommitFrameBody {
  ops: CommitOp[]
  time: string
  seq: number
}

const DEFAULT_BASE_DELAY_MS = 5_000
const DEFAULT_MAX_DELAY_MS = 60_000
const DEFAULT_JITTER_RATIO = 0.2
const DEFAULT_MAX_QUEUE_SIZE = 1_000
const WS_OPEN = 1

/**
 * Maintains a single per-actor WebSocket subscription to
 * `zone.stratos.sync.subscribeRecords?did=<did>` and feeds decoded commit
 * frames to the `SubscriptionIndexer`. Reconnects with the saved cursor on
 * drop; mints a fresh sync token on each (re)connect.
 */
export class ActorSyncer {
  private ws: WebSocketLike | null = null
  private running = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Uint8Array[] = []
  private draining = false
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterRatio: number
  private readonly maxQueueSize: number
  private readonly wsCtor: WebSocketCtor
  private readonly rng: () => number
  private connectGate: (() => Promise<void>) | null = null
  private lastMessageAt = Date.now()
  private lastConnectUrl: string | null = null

  constructor(
    private config: ActorSyncerConfig,
    private deps: ActorSyncerDeps,
  ) {
    this.baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.jitterRatio = config.jitterRatio ?? DEFAULT_JITTER_RATIO
    this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.wsCtor =
      deps.wsCtor ?? (globalThis.WebSocket as unknown as WebSocketCtor)
    this.rng = deps.rng ?? Math.random
  }

  get did(): string {
    return this.config.did
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN
  }

  getLastMessageAt(): number {
    return this.lastMessageAt
  }

  /** For tests: the URL of the most recent (re)connect attempt. */
  getLastConnectUrl(): string | null {
    return this.lastConnectUrl
  }

  /**
   * Set a gate function that must resolve before each connect attempt
   * proceeds. Used by `ActorPool` to enforce its global concurrency cap.
   */
  setConnectGate(gate: (() => Promise<void>) | null): void {
    this.connectGate = gate
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
    this.queue = []
    this.draining = false
  }

  private async connect(): Promise<void> {
    if (!this.running) return
    if (this.connectGate) {
      try {
        await this.connectGate()
      } catch (err) {
        this.deps.onError?.(err as Error)
        this.scheduleReconnect()
        return
      }
    }
    if (!this.running) return

    let token: string
    let cursor: number | null
    try {
      token = await this.config.mintToken()
      cursor = await this.deps.store.getCursor(this.config.did)
    } catch (err) {
      this.deps.onError?.(err as Error)
      this.scheduleReconnect()
      return
    }
    if (!this.running) return

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl, {
      did: this.config.did,
      cursor: cursor ?? undefined,
      syncToken: token,
    })
    this.lastConnectUrl = wsUrl

    let ws: WebSocketLike
    try {
      ws = new this.wsCtor(wsUrl)
    } catch (err) {
      this.deps.onError?.(err as Error)
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0
      this.lastMessageAt = Date.now()
    })

    ws.onmessage = (e: MessageEventLike) => {
      this.lastMessageAt = Date.now()
      const buf = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data)
      this.enqueue(buf)
    }

    ws.onerror = (e: ErrorEventLike) => {
      const errorMsg =
        e.error instanceof Error
          ? e.error.message
          : typeof e.error === 'string'
            ? e.error
            : (e.message ?? 'unknown')
      const cause = e.error instanceof Error ? e.error : undefined
      this.deps.onError?.(
        new StratosError(
          `Actor sync WS error for ${this.config.did}: ${errorMsg}`,
          'ACTOR_SYNC_ERROR',
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

  private enqueue(data: Uint8Array): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.deps.onError?.(
        new StratosError(
          `actor sync queue overflow for ${this.config.did}; dropping connection`,
          'ACTOR_SYNC_OVERFLOW',
        ),
      )
      if (this.ws) {
        try {
          this.ws.close()
        } catch {
          // ignore
        }
        this.ws = null
      }
      this.scheduleReconnect()
      return
    }
    this.queue.push(data)
    if (!this.draining) {
      void this.drain()
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0 && this.running) {
        const data = this.queue.shift()
        if (!data) continue
        await this.handleFrame(data)
      }
    } finally {
      this.draining = false
    }
  }

  private async handleFrame(data: Uint8Array): Promise<void> {
    let header: Record<string, unknown>
    let rest: Uint8Array
    try {
      ;[header, rest] = decodeFirst(data) as [
        Record<string, unknown>,
        Uint8Array,
      ]
    } catch (err) {
      this.deps.onError?.(err as Error)
      return
    }
    if (header['t'] !== '#commit') return
    let body: CommitFrameBody
    try {
      ;[body] = decodeFirst(rest) as [CommitFrameBody, Uint8Array]
    } catch (err) {
      this.deps.onError?.(err as Error)
      return
    }
    try {
      await this.deps.indexer.applyCommit({
        did: this.config.did,
        seq: body.seq,
        time: body.time,
        ops: body.ops,
      })
    } catch (err) {
      this.deps.onError?.(err as Error)
    }
  }
}

function buildWsUrl(
  serviceUrl: string,
  params: { did: string; cursor?: number; syncToken: string },
): string {
  const url = new URL(serviceUrl.replace(/^http/, 'ws'))
  url.pathname = '/xrpc/zone.stratos.sync.subscribeRecords'
  url.searchParams.set('did', params.did)
  if (params.cursor !== undefined) {
    url.searchParams.set('cursor', String(params.cursor))
  }
  url.searchParams.set('syncToken', params.syncToken)
  return url.toString()
}
