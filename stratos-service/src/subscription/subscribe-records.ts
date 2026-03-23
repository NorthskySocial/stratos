import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { decode as cborDecode } from '@atproto/lex-cbor'
import type { WebSocket } from 'ws'

import type { AppContext, EnrollmentEvent } from '../context.js'
import type { EnrollmentStoreReader } from '@northskysocial/stratos-core'

const WS_PING_INTERVAL_MS = 30_000

/**
 * Sequence event from stratos_seq table
 */
export interface SeqEvent {
  seq: number
  did: string
  time: string
  rev: string
  event: Uint8Array
}

/**
 * Record operation in a commit
 */
export interface RecordOp {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: unknown
}

/**
 * Commit message for subscription
 */
export interface CommitMessage {
  $type: 'zone.stratos.sync.subscribeRecords#commit'
  seq: number
  did: string
  time: string
  rev: string
  ops: RecordOp[]
}

/**
 * Info message for subscription
 */
export interface InfoMessage {
  $type: 'zone.stratos.sync.subscribeRecords#info'
  name: string
  message?: string
}

/**
 * Enrollment message for subscription
 */
export interface EnrollmentMessage {
  $type: 'zone.stratos.sync.subscribeRecords#enrollment'
  did: string
  action: 'enroll' | 'unenroll'
  service?: string
  boundaries?: string[]
  time: string
}

/**
 * Parameters for subscribeRecords
 */
export interface SubscribeRecordsParams {
  did?: string
  cursor?: number
  domain?: string
  syncToken?: string
}

type SubscriptionMessage = CommitMessage | InfoMessage | EnrollmentMessage

/**
 * Create the per-actor subscribeRecords stream handler.
 * Subscribes to record commits for a specific actor.
 */
function createActorSubscriptionHandler(ctx: AppContext) {
  return async function* subscribeActorRecords(
    did: string,
    cursor: number | undefined,
    domain: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<SubscriptionMessage> {
    const exists = await ctx.actorStore.exists(did)
    if (!exists) {
      throw new InvalidRequestError('Account not found', 'NotFound')
    }

    const latestSeq = await getLatestSeq(ctx, did)
    if (cursor !== undefined && cursor > latestSeq) {
      throw new InvalidRequestError('Cursor is in the future', 'FutureCursor')
    }

    const oldestSeq = await getOldestSeq(ctx, did)
    if (cursor !== undefined && cursor < oldestSeq) {
      yield {
        $type: 'zone.stratos.sync.subscribeRecords#info',
        name: 'OutdatedCursor',
        message: `Cursor ${cursor} is too old, some events may be missed`,
      }
    }

    let lastSeq = cursor ?? 0
    const catchUp = await getEventsSince(ctx, did, lastSeq)

    for (const event of catchUp) {
      if (signal.aborted) return
      if (domain && !matchesDomain(event, domain)) continue
      yield formatEvent(event)
      lastSeq = event.seq
    }

    // Event-driven: wait for sequenceEvents notification or 30s fallback
    while (!signal.aborted) {
      await waitForSequenceEvent(ctx, did, signal, 30_000)
      if (signal.aborted) return

      const newEvents = await getEventsSince(ctx, did, lastSeq)
      for (const event of newEvents) {
        if (signal.aborted) return
        if (domain && !matchesDomain(event, domain)) continue
        yield formatEvent(event)
        lastSeq = event.seq
      }
    }
  }
}

/**
 * Create the service-level subscription handler.
 * Replays all current enrollments on connection, then streams new events.
 */
function createServiceSubscriptionHandler(ctx: AppContext) {
  return async function* subscribeServiceEvents(
    signal: AbortSignal,
  ): AsyncGenerator<SubscriptionMessage> {
    const eventQueue: EnrollmentEvent[] = []

    const onEnrollment = (event: EnrollmentEvent) => {
      eventQueue.push(event)
    }

    // Register listener before replay so we don't miss events
    ctx.enrollmentEvents.on('enrollment', onEnrollment)

    try {
      // Replay all current enrollments so subscribers discover existing actors
      const store = ctx.enrollmentStore as unknown as EnrollmentStoreReader
      const replayedDids = new Set<string>()
      let cursor: string | undefined
      while (!signal.aborted) {
        const page = await store.listEnrollments({
          limit: 100,
          cursor,
        })
        if (page.length === 0) break

        for (const enrollment of page) {
          if (signal.aborted) return
          replayedDids.add(enrollment.did)
          const boundaries = await store.getBoundaries(enrollment.did)
          yield {
            $type: 'zone.stratos.sync.subscribeRecords#enrollment',
            did: enrollment.did,
            action: 'enroll' as const,
            boundaries,
            time: enrollment.enrolledAt,
          }
        }
        cursor = page[page.length - 1].did
      }

      // Stream real-time events, skipping any that were already replayed
      while (!signal.aborted) {
        while (eventQueue.length > 0) {
          if (signal.aborted) return
          const event = eventQueue.shift()!
          if (event.action === 'enroll' && replayedDids.has(event.did)) {
            continue
          }
          replayedDids.delete(event.did)
          yield {
            $type: 'zone.stratos.sync.subscribeRecords#enrollment',
            did: event.did,
            action: event.action,
            service: event.service,
            boundaries: event.boundaries,
            time: event.time,
          }
        }

        await sleep(500)
      }
    } finally {
      ctx.enrollmentEvents.off('enrollment', onEnrollment)
    }
  }
}

/**
 * Create the subscribeRecords stream handler.
 * - With `did`: per-actor record commit stream (existing behavior)
 * - Without `did`: service-level enrollment event stream
 */
export function createSubscribeRecordsHandler(ctx: AppContext) {
  const actorHandler = createActorSubscriptionHandler(ctx)
  const serviceHandler = createServiceSubscriptionHandler(ctx)

  return async function* subscribeRecords(
    params: SubscribeRecordsParams,
    auth: {
      credentials: {
        type: string
        did?: string
        iss?: string
        aud?: string
      }
    },
    signal: AbortSignal,
  ): AsyncGenerator<SubscriptionMessage> {
    const { did, cursor, domain } = params
    const isServiceAuth = auth?.credentials?.type === 'service'

    if (did) {
      const callerDid = auth?.credentials?.did
      const isOwnerAuth = callerDid === did
      if (!isOwnerAuth && !isServiceAuth) {
        throw new AuthRequiredError(
          'Service auth or owner authentication required',
        )
      }
      yield* actorHandler(did, cursor, domain, signal)
    } else {
      if (!isServiceAuth) {
        throw new AuthRequiredError(
          'Service auth required for service-level subscription',
        )
      }
      yield* serviceHandler(signal)
    }
  }
}

// Helper functions

async function getLatestSeq(ctx: AppContext, did: string): Promise<number> {
  try {
    return await ctx.actorStore.read(did, async (store) => {
      return store.sequence.getLatestSeq()
    })
  } catch (err) {
    ctx.logger?.warn({ did, err }, 'getLatestSeq failed')
    return 0
  }
}

async function getOldestSeq(ctx: AppContext, did: string): Promise<number> {
  try {
    return await ctx.actorStore.read(did, async (store) => {
      return store.sequence.getOldestSeq()
    })
  } catch (err) {
    ctx.logger?.warn({ did, err }, 'getOldestSeq failed')
    return 0
  }
}

async function getEventsSince(
  ctx: AppContext,
  did: string,
  cursor: number,
): Promise<SeqEvent[]> {
  try {
    return await ctx.actorStore.read(did, async (store) => {
      const rows = await store.sequence.getEventsSince(cursor, 100)

      return rows.map((row): SeqEvent => {
        let rev = ''
        try {
          const decoded = cborDecode(row.event) as Record<string, unknown>
          rev = (decoded.rev as string) ?? ''
        } catch {
          // Ignore decode errors
        }
        return {
          seq: row.seq,
          did: row.did,
          time: row.sequencedAt,
          rev,
          event: row.event,
        }
      })
    })
  } catch (err) {
    ctx.logger?.warn({ did, cursor, err }, 'getEventsSince failed')
    return []
  }
}

export function formatEvent(event: SeqEvent): CommitMessage {
  let ops: RecordOp[]

  try {
    const decoded = cborDecode(event.event) as Record<string, unknown>
    ops = Array.isArray(decoded.ops)
      ? (decoded.ops as RecordOp[])
      : [decoded as unknown as RecordOp]
  } catch {
    ops = []
  }

  return {
    $type: 'zone.stratos.sync.subscribeRecords#commit',
    seq: event.seq,
    did: event.did,
    time: event.time,
    rev: event.rev,
    ops,
  }
}

export function matchesDomain(event: SeqEvent, domain: string): boolean {
  try {
    const decoded = cborDecode(event.event) as Record<string, unknown>
    const ops = Array.isArray(decoded.ops) ? decoded.ops : [decoded]

    for (const op of ops as Record<string, unknown>[]) {
      const record = op.record as Record<string, unknown> | undefined
      const boundary = record?.boundary as Record<string, unknown> | undefined
      const values = boundary?.values as Array<{ value: string }> | undefined
      if (values) {
        const domains = values.map((d) => d.value)
        if (domains.includes(domain)) {
          return true
        }
      }
    }

    return false
  } catch {
    return true // Include it if we can't decode
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for a sequence event for the given DID, or until the timeout/abort fires.
 * Returns immediately if the DID emits a sequence event.
 * Falls back after timeoutMs to catch any missed events.
 */
function waitForSequenceEvent(
  ctx: AppContext,
  did: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      ctx.sequenceEvents.off(did, onEvent)
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      resolve()
    }
    const onEvent = () => settle()
    const onAbort = () => settle()
    const timer = setTimeout(settle, timeoutMs)
    ctx.sequenceEvents.on(did, onEvent)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Register the subscribeRecords handler with XRPC server
 */
export function registerSubscribeRecords(ctx: AppContext): void {
  const handler = createSubscribeRecordsHandler(ctx)

  ctx.xrpcServer.streamMethod('zone.stratos.sync.subscribeRecords', {
    auth: ctx.authVerifier.subscribeAuth,
    handler: async function* ({ params, auth, signal }) {
      ctx.logger?.info(
        {
          did: (params as Record<string, unknown>).did,
          authType: (auth as { credentials: { type: string } }).credentials
            .type,
        },
        'subscribeRecords connected',
      )
      const typedParams = params as unknown as SubscribeRecordsParams
      const typedAuth = auth as {
        credentials: {
          type: string
          did?: string
          iss?: string
          aud?: string
        }
      }

      for await (const event of handler(typedParams, typedAuth, signal)) {
        yield event
      }
    },
  })

  // Configure WebSocket ping/pong to keep connections alive through ALBs
  const sub = (
    ctx.xrpcServer as unknown as {
      subscriptions: Map<
        string,
        { wss: { on: (event: string, cb: (ws: WebSocket) => void) => void } }
      >
    }
  ).subscriptions.get('zone.stratos.sync.subscribeRecords')
  if (sub) {
    sub.wss.on('connection', (ws: WebSocket) => {
      let alive = true
      ws.on('pong', () => {
        alive = true
      })
      const interval = setInterval(() => {
        if (!alive) {
          ws.terminate()
          clearInterval(interval)
          return
        }
        alive = false
        ws.ping()
      }, WS_PING_INTERVAL_MS)
      ws.on('close', () => clearInterval(interval))
    })
    ctx.logger?.info('WebSocket ping/pong configured (interval: 30s)')
  }
}
