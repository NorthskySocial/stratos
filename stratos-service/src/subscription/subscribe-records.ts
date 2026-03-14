import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { decode as cborDecode } from '@atproto/lex-cbor'

import type { AppContext } from '../context.js'

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
 * Parameters for subscribeRecords
 */
export interface SubscribeRecordsParams {
  did: string
  cursor?: number
  domain?: string
  syncToken?: string
}

/**
 * Create the subscribeRecords stream handler
 */
export function createSubscribeRecordsHandler(ctx: AppContext) {
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
  ): AsyncGenerator<CommitMessage | InfoMessage> {
    const { did, cursor, domain } = params

    // Validate authentication
    const callerDid = auth?.credentials?.did
    const isServiceAuth = auth?.credentials?.type === 'service'
    const isOwnerAuth = callerDid === did

    if (!isOwnerAuth && !isServiceAuth) {
      throw new AuthRequiredError(
        'Service auth or owner authentication required',
      )
    }

    // Check if actor store exists
    const exists = await ctx.actorStore.exists(did)
    if (!exists) {
      throw new InvalidRequestError('Account not found', 'NotFound')
    }

    // If cursor is in the future, error
    const latestSeq = await getLatestSeq(ctx, did)
    if (cursor !== undefined && cursor > latestSeq) {
      throw new InvalidRequestError('Cursor is in the future', 'FutureCursor')
    }

    // If cursor is outdated, send info message
    const oldestSeq = await getOldestSeq(ctx, did)
    if (cursor !== undefined && cursor < oldestSeq) {
      yield {
        $type: 'zone.stratos.sync.subscribeRecords#info',
        name: 'OutdatedCursor',
        message: `Cursor ${cursor} is too old, some events may be missed`,
      }
    }

    // Emit historical events from cursor
    let lastSeq = cursor ?? 0
    const catchUp = await getEventsSince(ctx, did, lastSeq)

    for (const event of catchUp) {
      if (signal.aborted) return

      // Filter by domain if specified
      if (domain && !matchesDomain(event, domain)) {
        continue
      }

      yield formatEvent(event)
      lastSeq = event.seq
    }

    // Now poll for new events
    while (!signal.aborted) {
      // Wait a bit before polling
      await sleep(500)

      if (signal.aborted) return

      // Check for new events
      const newEvents = await getEventsSince(ctx, did, lastSeq)

      for (const event of newEvents) {
        if (signal.aborted) return

        // Filter by domain if specified
        if (domain && !matchesDomain(event, domain)) {
          continue
        }

        yield formatEvent(event)
        lastSeq = event.seq
      }
    }
  }
}

// Helper functions

async function getLatestSeq(ctx: AppContext, did: string): Promise<number> {
  try {
    return await ctx.actorStore.read(did, async (store) => {
      return store.sequence.getLatestSeq()
    })
  } catch {
    return 0
  }
}

async function getOldestSeq(ctx: AppContext, did: string): Promise<number> {
  try {
    return await ctx.actorStore.read(did, async (store) => {
      return store.sequence.getOldestSeq()
    })
  } catch {
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
  } catch {
    return []
  }
}

export function formatEvent(event: SeqEvent): CommitMessage {
  let ops: RecordOp[]

  try {
    const decoded = cborDecode(event.event) as Record<string, unknown>
    ops = Array.isArray(decoded.ops) ? (decoded.ops as RecordOp[]) : [decoded as unknown as RecordOp]
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
 * Register the subscribeRecords handler with XRPC server
 */
export function registerSubscribeRecords(ctx: AppContext): void {
  const handler = createSubscribeRecordsHandler(ctx)

  ctx.xrpcServer.streamMethod('zone.stratos.sync.subscribeRecords', {
    auth: ctx.authVerifier.subscribeAuth,
    handler: async function* ({ params, auth, signal }) {
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
}
