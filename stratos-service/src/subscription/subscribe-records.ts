import { AuthRequiredError } from '@atproto/xrpc-server'
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
 *
 * `boundary` carries the op's domain set explicitly, independent of `record`.
 * It exists so a scoped removal (e.g. a move's old-home tombstone) can be gated
 * to the boundary it left WITHOUT inlining the record body — deletes never leak
 * content. When absent, boundaries are decoded from `record.boundary` as usual.
 */
export interface RecordOp {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: unknown
  boundary?: { values?: Array<{ value: string }> }
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
 * Enrollment message for subscription.
 *
 * `action`:
 * - `enroll` / `unenroll`: an actor entered / fully left the service.
 * - `boundaries` (SWP-13): the actor stayed enrolled but its boundary set
 *   changed. `boundaries` carries the set AFTER the change (`boundaries-after`).
 *   Consumers diff this against their held snapshot and purge derived state for
 *   any boundary the actor left. This closes SWP-12 Deviation D-1, which lacked
 *   a stream trigger for boundary-set shrinks.
 */
export interface EnrollmentMessage {
  $type: 'zone.stratos.sync.subscribeRecords#enrollment'
  did: string
  action: 'enroll' | 'unenroll' | 'boundaries'
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
}

type SubscriptionMessage = CommitMessage | InfoMessage | EnrollmentMessage

/**
 * Create the per-actor subscribeRecords stream handler.
 * Subscribes to record commits for a specific actor.
 *
 * @param ctx - Application context
 * @returns Actor subscription handler function
 */
function createActorSubscriptionHandler(ctx: AppContext) {
  return async function* subscribeActorRecords(
    did: string,
    cursor: number | undefined,
    domain: string | undefined,
    callerBoundaries: ReadonlySet<string>,
    signal: AbortSignal,
  ): AsyncGenerator<SubscriptionMessage> {
    // The actor store is created lazily on the actor's first write. An enrolled
    // actor that hasn't posted yet (or whose enrollment event raced ahead of
    // repo initialization) has no store. Rather than closing the stream — which
    // pushes the client into a reconnect loop — hold the connection open and
    // begin streaming once the store appears on first write.
    if (!(await ctx.actorStore.exists(did))) {
      yield* streamNewEvents(
        ctx,
        did,
        cursor ?? 0,
        domain,
        callerBoundaries,
        signal,
      )
      return
    }

    const latestSeq = await getLatestSeq(ctx, did)

    let lastSeq = cursor ?? 0
    if (cursor !== undefined && cursor > latestSeq) {
      // The client's cursor is ahead of our newest event, which happens when
      // the actor store was reset while the client retained its old cursor.
      // Resume from the latest sequence instead of rejecting the connection,
      // which the client would otherwise retry indefinitely.
      ctx.logger?.warn(
        { did, cursor, latestSeq },
        'subscribeRecords: cursor ahead of latest, resuming from latest',
      )
      lastSeq = latestSeq
    } else {
      const oldestSeq = await getOldestSeq(ctx, did)
      if (cursor !== undefined && cursor < oldestSeq) {
        yield {
          $type: 'zone.stratos.sync.subscribeRecords#info',
          name: 'OutdatedCursor',
          message: `Cursor ${cursor} is too old, some events may be missed`,
        }
      }

      const catchUp = await getEventsSince(ctx, did, lastSeq)
      for (const event of catchUp) {
        if (signal.aborted) return
        const message = emitEvent(ctx, event, callerBoundaries, domain)
        if (message) yield message
        lastSeq = event.seq
      }
    }

    yield* streamNewEvents(ctx, did, lastSeq, domain, callerBoundaries, signal)
  }
}

/**
 * Decode an event once and return its commit message if the event is in scope
 * for the caller's boundaries, otherwise `undefined`. Undecodable events are
 * dropped (fail closed) and logged.
 * @param ctx - Application context
 * @param event - Sequence event to evaluate
 * @param callerBoundaries - Boundaries the subscribing service is enrolled in
 * @param domain - Optional single-boundary narrowing within the shared set
 * @returns The commit message to emit, or undefined to skip the event
 */
function emitEvent(
  ctx: AppContext,
  event: SeqEvent,
  callerBoundaries: ReadonlySet<string>,
  domain: string | undefined,
): CommitMessage | undefined {
  const decoded = decodeEvent(event)
  if (!decoded.decodeOk) {
    ctx.logger?.warn(
      { did: event.did, seq: event.seq },
      'subscribeRecords: dropping undecodable event (fail closed)',
    )
    return undefined
  }
  if (!eventInScope(decoded, callerBoundaries, domain)) return undefined
  return formatEvent(event, decoded.ops)
}

/**
 * Stream new events from the actor store for a given DID.
 * @param ctx - The application context.
 * @param did - The DID to subscribe to.
 * @param startSeq - The sequence number to start from.
 * @param domain - The domain to filter events by.
 * @param callerBoundaries - Boundaries the subscribing service is enrolled in.
 * @param signal - The abort signal to stop the stream.
 * @returns An async generator that yields commit messages for new events.
 */
async function* streamNewEvents(
  ctx: AppContext,
  did: string,
  startSeq: number,
  domain: string | undefined,
  callerBoundaries: ReadonlySet<string>,
  signal: AbortSignal,
): AsyncGenerator<SubscriptionMessage> {
  let lastSeq = startSeq
  while (!signal.aborted) {
    await waitForSequenceEvent(ctx, did, signal, 30_000)
    if (signal.aborted) return

    const newEvents = await getEventsSince(ctx, did, lastSeq)
    for (const event of newEvents) {
      if (signal.aborted) return
      const message = emitEvent(ctx, event, callerBoundaries, domain)
      if (message) {
        yield message
      }
      lastSeq = event.seq
    }
  }
}

/**
 * Create the service-level subscription handler.
 * Replays all current enrollments on connection, then streams new events.
 *
 * @param ctx - Application context
 * @returns Service subscription handler function
 */
function createServiceSubscriptionHandler(ctx: AppContext) {
  return async function* subscribeServiceEvents(
    callerBoundaries: ReadonlySet<string>,
    signal: AbortSignal,
  ): AsyncGenerator<SubscriptionMessage> {
    const eventQueue: EnrollmentEvent[] = []

    const onEnrollment = (event: EnrollmentEvent) => {
      eventQueue.push(event)
    }

    // Register listener before replay so we don't miss events
    ctx.enrollmentEvents.on('enrollment', onEnrollment)

    try {
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
          if (signal.aborted) break
          // Peer services discover users, not each other.
          if (enrollment.isService) continue
          const boundaries = await store.getBoundaries(enrollment.did)
          if (!hasBoundaryIntersection(callerBoundaries, boundaries)) continue
          replayedDids.add(enrollment.did)
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
          if (!eventVisibleToCaller(callerBoundaries, event)) {
            continue
          }
          if (event.action === 'enroll' && replayedDids.has(event.did)) {
            continue
          }
          replayedDids.delete(event.did)
          yield {
            $type: 'zone.stratos.sync.subscribeRecords#enrollment',
            did: event.did,
            action: event.action,
            service: event.service,
            // Wire frame carries only `{did, boundaries-after}` — the
            // scoping-only `priorBoundaries` field is never emitted.
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
 *
 * All access requires inter-service auth and is scoped to the calling service's
 * enrolled boundaries:
 * - With `did`: per-actor record commit stream, filtered to the caller's boundaries.
 * - Without `did`: service-level enrollment event stream over shared-boundary users.
 *
 * @param ctx - Application context
 * @returns SubscribeRecords stream handler function
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

    if (auth?.credentials?.type !== 'service') {
      throw new AuthRequiredError('Service auth required')
    }

    const callerDid = auth.credentials.iss ?? auth.credentials.did
    if (!callerDid) {
      throw new AuthRequiredError('Service auth required')
    }

    const boundaries = await ctx.enrollmentStore.getBoundaries(callerDid)
    if (boundaries.length === 0) {
      throw new AuthRequiredError('Service is not enrolled in any boundary')
    }
    const callerBoundaries = new Set(boundaries)

    if (did) {
      yield* actorHandler(did, cursor, domain, callerBoundaries, signal)
    } else {
      yield* serviceHandler(callerBoundaries, signal)
    }
  }
}

// Helper functions

/**
 * Get latest sequence number for a DID
 * @param ctx - Application context
 * @param did - Decentralized Identifier (DID) for which to get the latest sequence number
 * @returns Latest sequence number for the DID
 */
async function getLatestSeq(ctx: AppContext, did: string): Promise<number> {
  // Reading opens (and therefore creates) the actor SQLite file. Skip the read
  // for actors without a store so we never materialize an empty database.
  if (!(await ctx.actorStore.exists(did))) return 0
  try {
    return await ctx.actorStore.read(did, async (store) => {
      return store.sequence.getLatestSeq()
    })
  } catch (err) {
    ctx.logger?.warn({ did, err }, 'getLatestSeq failed')
    return 0
  }
}

/**
 * Get oldest sequence number for a DID
 * @param ctx - Application context
 * @param did - Decentralized Identifier (DID) for which to get the oldest sequence number
 * @returns Oldest sequence number for the DID
 */
async function getOldestSeq(ctx: AppContext, did: string): Promise<number> {
  if (!(await ctx.actorStore.exists(did))) return 0
  try {
    return await ctx.actorStore.read(did, async (store) => {
      return store.sequence.getOldestSeq()
    })
  } catch (err) {
    ctx.logger?.warn({ did, err }, 'getOldestSeq failed')
    return 0
  }
}

/**
 * Get events since a given sequence number for a DID
 * @param ctx - Application context
 * @param did - Decentralized Identifier (DID) for which to get events
 * @param cursor - Sequence number to start from
 * @returns Array of sequence events since the cursor
 */
async function getEventsSince(
  ctx: AppContext,
  did: string,
  cursor: number,
): Promise<SeqEvent[]> {
  // Avoid opening (and creating) a SQLite file for actors that have not written
  // yet; the streaming loop polls this until the store appears on first write.
  if (!(await ctx.actorStore.exists(did))) return []
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

/**
 * An event decoded from its CBOR payload exactly once.
 * `decodeOk` is false when the payload could not be decoded — callers treating
 * boundaries as an access-control gate MUST fail closed in that case.
 */
export interface DecodedEvent {
  ops: RecordOp[]
  boundaries: string[]
  decodeOk: boolean
}

/**
 * Decode a sequence event's CBOR payload a single time, extracting both the
 * record ops and the union of boundary values across those ops.
 * @param event - Sequence event to decode
 * @returns Decoded ops + boundaries, with `decodeOk = false` on failure
 */
export function decodeEvent(event: SeqEvent): DecodedEvent {
  try {
    const decoded = cborDecode(event.event) as Record<string, unknown>
    const rawOps = Array.isArray(decoded.ops)
      ? (decoded.ops as Record<string, unknown>[])
      : [decoded]

    const boundaries = new Set<string>()
    for (const op of rawOps) {
      // Prefer an explicit op-level boundary (a scoped removal carries its old
      // domain here without a record body); otherwise fall back to the record's
      // own boundary. This lets a move's removal op be gated to the domain it
      // left while emitting a clean delete (no content).
      const record = op.record as Record<string, unknown> | undefined
      const opBoundary = op.boundary as Record<string, unknown> | undefined
      const recordBoundary = record?.boundary as
        | Record<string, unknown>
        | undefined
      const boundary = opBoundary ?? recordBoundary
      const values = boundary?.values as Array<{ value: string }> | undefined
      if (values) {
        for (const v of values) boundaries.add(v.value)
      }
    }

    return {
      ops: rawOps as unknown as RecordOp[],
      boundaries: [...boundaries],
      decodeOk: true,
    }
  } catch {
    return { ops: [], boundaries: [], decodeOk: false }
  }
}

/**
 * Format a sequence event into a commit message.
 * @param event - Sequence event to format
 * @param ops - Pre-decoded ops (avoids re-decoding on the hot path). When
 *   omitted, the event is decoded internally.
 * @returns Commit message representation of the sequence event
 */
export function formatEvent(event: SeqEvent, ops?: RecordOp[]): CommitMessage {
  return {
    $type: 'zone.stratos.sync.subscribeRecords#commit',
    seq: event.seq,
    did: event.did,
    time: event.time,
    rev: event.rev,
    ops: ops ?? decodeEvent(event).ops,
  }
}

/**
 * Whether a decoded event is in scope for a viewer holding `callerBoundaries`.
 *
 * This is an access-control gate, so it FAILS CLOSED: an event whose payload
 * could not be decoded has unverifiable boundaries and is denied. An event is
 * in scope only if at least one of its boundaries is in the caller's set; an
 * optional `domain` narrows further within that shared set.
 *
 * @param decoded - Event decoded via {@link decodeEvent}
 * @param callerBoundaries - Boundaries the subscribing service is enrolled in
 * @param domain - Optional single-boundary narrowing within the shared set
 * @returns True if the event may be emitted to the caller
 */
export function eventInScope(
  decoded: DecodedEvent,
  callerBoundaries: ReadonlySet<string>,
  domain?: string,
): boolean {
  if (!decoded.decodeOk) return false
  const shared = decoded.boundaries.filter((b) => callerBoundaries.has(b))
  if (shared.length === 0) return false
  if (domain) return shared.includes(domain)
  return true
}

/**
 * Whether any of `boundaries` is present in `callerBoundaries`.
 * @param callerBoundaries - Boundaries the subscribing service is enrolled in
 * @param boundaries - Boundaries to test for intersection
 * @returns True if the two sets intersect
 */
export function hasBoundaryIntersection(
  callerBoundaries: ReadonlySet<string>,
  boundaries: string[] | undefined,
): boolean {
  if (!boundaries) return false
  return boundaries.some((b) => callerBoundaries.has(b))
}

/**
 * Whether an enrollment event should be delivered to a caller holding
 * `callerBoundaries`.
 *
 * `enroll`/`unenroll` retain the pre-SWP-13 semantics exactly: a plain
 * intersection against the event's own boundary set.
 *
 * A `boundaries` change (SWP-13) is different: the after-set alone is
 * insufficient, because a pure shrink that removes the last boundary the caller
 * shares would no longer intersect the caller's set and the caller would never
 * learn the actor left its scope. So the change is delivered when the caller's
 * set intersects EITHER the prior set OR the after-set; the caller then diffs
 * the after-set against its own held snapshot to decide what to purge.
 *
 * @param callerBoundaries - Boundaries the subscribing service is enrolled in
 * @param event - The enrollment event under consideration
 * @returns True if the event is in the caller's scope
 */
export function eventVisibleToCaller(
  callerBoundaries: ReadonlySet<string>,
  event: EnrollmentEvent,
): boolean {
  if (event.action === 'boundaries') {
    return (
      hasBoundaryIntersection(callerBoundaries, event.priorBoundaries) ||
      hasBoundaryIntersection(callerBoundaries, event.boundaries)
    )
  }
  return hasBoundaryIntersection(callerBoundaries, event.boundaries)
}

/**
 * Sleep for the given number of milliseconds
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for a sequence event for the given DID, or until the timeout/abort fires.
 * Returns immediately if the DID emits a sequence event.
 * Falls back after timeoutMs to catch any missed events.
 *
 * @param ctx - Application context
 * @param did - Decentralized Identifier (DID) for which to wait for sequence events
 * @param signal - Abort signal to cancel the wait operation
 * @param timeoutMs - Timeout in milliseconds to wait for sequence events
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
 * Register the subscribeRecords handler with the XRPC server
 *
 * @param ctx - Application context
 */
export function registerSubscribeRecords(ctx: AppContext): void {
  const handler = createSubscribeRecordsHandler(ctx)

  ctx.xrpcServer.streamMethod('zone.stratos.sync.subscribeRecords', {
    auth: ctx.authVerifier.subscribeAuth,
    handler: async function* ({ params, auth, signal }) {
      const connDid = (params as Record<string, unknown>).did
      const authType = (auth as { credentials: { type: string } }).credentials
        .type
      ctx.logger?.info(
        {
          did: connDid,
          authType,
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

      yield* handler(typedParams, typedAuth, signal)
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
      ws.on('close', () => {
        clearInterval(interval)
      })
    })
    ctx.logger?.info('WebSocket ping/pong configured (interval: 30s)')
  }
}
