// copied from stratos-indexer/src/sync/actor-syncer.ts @ 57f907ca8600ff736a30beb2915836b7dca90106
// Todo: extract a shared stratos-sync library used by both the indexer and feedgen
import { decodeFirst } from '@atcute/cbor'
import { StratosError } from '@northskysocial/stratos-core'
import { WebSocket as NodeWebSocket } from 'ws'
import { upstreamTraceHeaders } from '../observability/tracing.js'
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

interface WebSocketConnectOptions {
  headers?: Record<string, string>
}

type WebSocketCtor = new (
  url: string,
  options?: WebSocketConnectOptions,
) => WebSocketLike

export interface ActorSyncerConfig {
  did: string
  stratosServiceUrl: string
  mintToken: () => Promise<string>
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  maxQueueSize?: number
  /**
   * How long a connection must stay open before its backoff counter is reset.
   * Prevents an accept-then-immediately-close loop from reconnecting forever at
   * the base delay without ever escalating.
   */
  stabilityResetMs?: number
  /** Observability hook: reconnects are otherwise invisible to metrics. */
  onReconnectScheduled?: () => void
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
const DEFAULT_STABILITY_RESET_MS = 30_000
const WS_OPEN = 1
/**
 * Consecutive failures at the SAME sequence before a distinct stall alarm is
 * raised. The sequence is still retried indefinitely rather than being passed
 * over: a lost commit is unrecoverable (the feedgen has no backfill path and
 * serves feeds straight from its index), whereas a stalled actor is observable
 * and heals on its own once the underlying fault clears.
 */
const APPLY_FAILURE_ALARM_THRESHOLD = 3

/**
 * Maintains a single per-actor WebSocket subscription to
 * `zone.stratos.sync.subscribeRecords?did=<did>` and feeds decoded commit
 * frames to the `SubscriptionIndexer`. Reconnects with the saved cursor on
 * drop; mints a fresh service-auth JWT (sent as an `Authorization: Bearer`
 * header on the upgrade) on each (re)connect.
 */
export class ActorSyncer {
  private ws: WebSocketLike | null = null
  private running = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Uint8Array[] = []
  private draining = false
  private drainPromise: Promise<void> = Promise.resolve()
  private lastFailedSeq: number | null = null
  private sameSeqFailures = 0
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterRatio: number
  private readonly maxQueueSize: number
  private readonly stabilityResetMs: number
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
    this.stabilityResetMs =
      config.stabilityResetMs ?? DEFAULT_STABILITY_RESET_MS
    this.wsCtor = deps.wsCtor ?? (NodeWebSocket as unknown as WebSocketCtor)
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
    this.clearStabilityTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.detachSocket()
    // `draining` belongs to drain(): clearing it here while a frame is still in
    // flight would let a later start() launch a second concurrent drain. The
    // drain loop already exits on `!running` and clears the flag itself.
    this.queue = []
  }

  /**
   * Stop and wait for the frame in flight (if any) to finish applying. Cursors
   * are durable per applied commit, so awaiting this drain is what guarantees
   * the last `applyCommit` → `upsertCursor` completes before the DB closes.
   * `stop()` itself stays a synchronous signal to avoid reintroducing the
   * double-drain race its comment guards against.
   */
  async drainAndStop(): Promise<void> {
    this.stop()
    await this.drainPromise
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
    })
    this.lastConnectUrl = wsUrl

    let ws: WebSocketLike
    try {
      ws = new this.wsCtor(wsUrl, {
        headers: {
          ...upstreamTraceHeaders(),
          authorization: `Bearer ${token}`,
        },
      })
    } catch (err) {
      this.deps.onError?.(err as Error)
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      this.lastMessageAt = Date.now()
      this.armStabilityReset()
    })

    ws.onmessage = (e: MessageEventLike) => {
      // A superseded socket must not refill a queue that was just cleared.
      if (this.ws !== ws) return
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
      // A socket we already gave up on closes on its own schedule, which can be
      // later than the reconnect that replaced it. Acting on that close would
      // detach the live socket instead, and every frame it delivered would then
      // be dropped by the superseded-socket guard in `onmessage`.
      if (this.ws !== ws) return
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
    this.config.onReconnectScheduled?.()
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

  /**
   * Abandon the current connection without advancing the cursor. Everything
   * still buffered is discarded rather than applied: the reconnect replays it
   * from the last durable cursor, so discarding is lossless, while applying it
   * would carry the cursor past the sequence we just failed on.
   */
  private failConnection(): void {
    this.queue = []
    this.detachSocket()
    this.scheduleReconnect()
  }

  /**
   * Close the current socket and give up ownership of it at once. `close()`
   * only starts the closing handshake — the close event can land well after the
   * reconnect that follows — so ownership is dropped here rather than in
   * `onclose`, and the detached socket's own close is then ignored.
   */
  private detachSocket(): void {
    const ws = this.ws
    if (!ws) return
    this.ws = null
    this.clearStabilityTimer()
    try {
      ws.close()
    } catch {
      // ignore close errors
    }
  }

  private enqueue(data: Uint8Array): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.deps.onError?.(
        new StratosError(
          `actor sync queue overflow for ${this.config.did}; dropping connection`,
          'ACTOR_SYNC_OVERFLOW',
        ),
      )
      this.failConnection()
      return
    }
    this.queue.push(data)
    if (!this.draining) {
      this.drainPromise = this.drain()
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

  /**
   * Decode a frame and apply its commit.
   *
   * The two failure paths here have deliberately opposite policies.
   *
   * An *apply* failure stalls (`failConnection`): it is normally a transient
   * store fault, so retrying the sequence eventually succeeds, and advancing
   * past it would drop the commit permanently — the feedgen serves feeds from
   * its own index and has no backfill path.
   *
   * A *decode* failure continues. It cannot be retried, because the frame
   * decodes identically on replay, so stalling would wedge this actor forever
   * with no fault that can clear. It also means version skew rather than
   * corruption — the upstream fails closed on events it cannot decode, so a
   * frame reaching us undecodable implies a framing/CBOR mismatch that would
   * hit every actor at once; stalling would take the whole feedgen down on a
   * protocol change. The accepted cost is that the next successful commit
   * advances the cursor past the lost frame, so these are reported loudly
   * under their own code.
   *
   * A body that decodes but has the wrong *shape* is a decode failure too, and
   * must be caught here rather than handed to `applyCommit`: a non-array `ops`
   * would throw inside the apply and be misread as a transient store fault,
   * stalling the actor forever on a frame that can never succeed, and a
   * non-numeric `seq` would be written straight to the cursor.
   */
  private async handleFrame(data: Uint8Array): Promise<void> {
    let header: Record<string, unknown>
    let rest: Uint8Array
    try {
      ;[header, rest] = decodeFirst(data) as [
        Record<string, unknown>,
        Uint8Array,
      ]
    } catch (err) {
      this.deps.onError?.(
        new StratosError(
          `undecodable frame header for ${this.config.did}`,
          'ACTOR_SYNC_FRAME_UNDECODABLE',
          { cause: err },
        ),
      )
      return
    }
    if (header['t'] !== '#commit') return
    let decoded: unknown
    try {
      ;[decoded] = decodeFirst(rest) as [unknown, Uint8Array]
    } catch (err) {
      this.deps.onError?.(
        new StratosError(
          `undecodable commit body for ${this.config.did}`,
          'ACTOR_SYNC_FRAME_UNDECODABLE',
          { cause: err },
        ),
      )
      return
    }
    if (!isCommitFrameBody(decoded)) {
      this.deps.onError?.(
        new StratosError(
          `malformed commit body for ${this.config.did}`,
          'ACTOR_SYNC_FRAME_UNDECODABLE',
        ),
      )
      return
    }
    const body = decoded
    try {
      await this.deps.indexer.applyCommit({
        did: this.config.did,
        seq: body.seq,
        time: body.time,
        ops: body.ops,
      })
      this.lastFailedSeq = null
      this.sameSeqFailures = 0
    } catch (err) {
      this.recordApplyFailure(body.seq, err)
      this.failConnection()
    }
  }

  /**
   * Report an apply failure and, once the same sequence has failed
   * `APPLY_FAILURE_ALARM_THRESHOLD` times in a row, raise one distinct alarm.
   * The alarm fires once per stall episode so a wedged actor produces a signal
   * rather than a stream of noise.
   */
  private recordApplyFailure(seq: number, err: unknown): void {
    if (seq === this.lastFailedSeq) {
      this.sameSeqFailures++
    } else {
      this.lastFailedSeq = seq
      this.sameSeqFailures = 1
    }
    this.deps.onError?.(
      new StratosError(
        `commit apply failed for ${this.config.did} at seq ${seq}`,
        'ACTOR_SYNC_APPLY_FAILED',
        { cause: err },
      ),
    )
    if (this.sameSeqFailures === APPLY_FAILURE_ALARM_THRESHOLD) {
      this.deps.onError?.(
        new StratosError(
          `actor sync stalled for ${this.config.did} at seq ${seq} after ${this.sameSeqFailures} consecutive apply failures; retrying indefinitely`,
          'ACTOR_SYNC_STALLED',
        ),
      )
    }
  }
}

/**
 * Whether a decoded commit body carries the three fields the apply path relies
 * on. `seq` must be a real number because it becomes the durable cursor, and
 * `ops` must be iterable because `applyCommit` loops it. Non-object bodies need
 * no arm of their own: indexing a scalar yields `undefined` and fails the field
 * checks anyway, so only `null`/`undefined` — which throw on index — have to be
 * turned away up front.
 */
function isCommitFrameBody(value: unknown): value is CommitFrameBody {
  if (!value) return false
  const body = value as Record<string, unknown>
  return (
    Number.isFinite(body['seq']) &&
    typeof body['time'] === 'string' &&
    Array.isArray(body['ops'])
  )
}

function buildWsUrl(
  serviceUrl: string,
  params: { did: string; cursor?: number },
): string {
  const url = new URL(serviceUrl.replace(/^http/, 'ws'))
  url.pathname = '/xrpc/zone.stratos.sync.subscribeRecords'
  url.searchParams.set('did', params.did)
  if (params.cursor !== undefined) {
    url.searchParams.set('cursor', String(params.cursor))
  }
  return url.toString()
}
