import { decodeFirst } from '@atcute/cbor'
import { Kysely } from 'kysely'
import { extractBoundaries, StratosError } from '@northskysocial/stratos-core'
import type { CursorManager } from '../storage/cursor-manager.ts'
import type { PostTable, StratosIndexerSchema } from '../storage/schema.ts'

const STRATOS_POST_COLLECTION = 'zone.stratos.feed.post'
const INDEX_TRACE_WARN_LAG_MS = 5_000

export interface ActorQueue {
  pending: Uint8Array[]
  draining: boolean
}

export interface RecordUpsert {
  uri: string
  cid: string
  record: Record<string, unknown>
  trace?: {
    requestId?: string
    queuedAtMs?: number
  }
}

export interface ActorSyncerOptions {
  stratosServiceUrl: string
  syncToken: string
  maxActorQueueSize: number
  drainDelayMs: number
  reconnectBaseDelayMs: number
  reconnectMaxDelayMs: number
  reconnectJitterMs: number
  reconnectMaxAttempts: number
  onReferencedActor?: (did: string) => void
  onHandleNeeded?: (did: string) => void
  onError?: (err: Error) => void
  onIndexed?: (count: number) => void
  onDeleted?: (count: number) => void
  onConnectionStatusChange?: (did: string, connected: boolean) => void
  onGlobalPendingChange?: (delta: number) => void
  canStartSync: () => boolean
  onSyncStarted: () => void
  onSyncFinished: () => void
}

interface StratosSyncCommit {
  t: '#commit'
  ops: {
    action: 'create' | 'update' | 'delete'
    path: string
    cid?: string
    record?: unknown
    trace?: {
      requestId?: string
      queuedAtMs?: number
    }
  }[]
  time: string
  seq: number
}

interface XrpcFrame {
  t: string
  [key: string]: unknown
}

interface StratosSyncParams {
  did: string
  cursor?: number
  syncToken: string
}

/**
 * ActorSyncer manages the synchronization of actor data with Stratos.
 */
export class ActorSyncer {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private intentionallyClosed = false
  private queue: ActorQueue = { pending: [], draining: false }
  private lastMessageAt = Date.now()

  constructor(
    private did: string,
    private db: Kysely<StratosIndexerSchema>,
    private cursorManager: CursorManager,
    private options: ActorSyncerOptions,
  ) {}

  /**
   * Check if the WebSocket connection is currently open.
   *
   * @returns True if the connection is open, false otherwise.
   */
  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Get the timestamp of the last message received from Stratos.
   *
   * @returns Timestamp of the last message.
   */
  public getLastMessageAt(): number {
    return this.lastMessageAt
  }

  /**
   * Get the size of the pending message queue.
   *
   * @returns Number of pending messages.
   */
  public getQueueSize(): number {
    return this.queue.pending.length
  }

  /**
   * Start the actor synchronization process.
   * Initiates the WebSocket connection and begins processing messages.
   */
  public start(): void {
    this.intentionallyClosed = false
    this.connect()
  }

  /**
   * Stop the actor synchronization process.
   * Closes the WebSocket connection and stops processing messages.
   */
  public stop(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Connect to the Stratos service and start processing messages.
   * @private
   */
  private connect(): void {
    if (this.intentionallyClosed) return

    const cursor = this.cursorManager.getStratosCursor(this.did)
    const wsUrl = buildWsUrl(this.options.stratosServiceUrl, {
      did: this.did,
      cursor,
      syncToken: this.options.syncToken,
    })

    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.options.onConnectionStatusChange?.(this.did, true)
      this.lastMessageAt = Date.now()
    }

    this.ws.onmessage = (e: MessageEvent) => {
      this.lastMessageAt = Date.now()
      this.enqueueMessage(new Uint8Array(e.data as ArrayBuffer))
    }

    this.ws.onerror = (e: Event & { error?: unknown }) => {
      if (!this.intentionallyClosed) {
        this.options.onError?.(
          new StratosError(
            `WebSocket error for ${this.did}: ${e.error || 'unknown'}`,
          ),
        )
      }
    }

    this.ws.onclose = () => {
      this.ws = null
      this.options.onConnectionStatusChange?.(this.did, false)
      if (!this.intentionallyClosed) {
        this.scheduleReconnect()
      }
    }
  }

  /**
   * Schedule a reconnection attempt after a delay.
   * Handles exponential backoff with jitter to avoid overloading the server.
   * @private
   */
  private scheduleReconnect(): void {
    if (this.intentionallyClosed || this.reconnectTimer) return

    this.reconnectAttempts++
    if (this.reconnectAttempts > this.options.reconnectMaxAttempts) {
      this.options.onError?.(
        new Error(`Max reconnect attempts reached for actor ${this.did}`),
      )
      return
    }

    const delay = Math.min(
      this.options.reconnectBaseDelayMs *
        Math.pow(2, this.reconnectAttempts - 1),
      this.options.reconnectMaxDelayMs,
    )
    const jitter = Math.random() * this.options.reconnectJitterMs
    const finalDelay = delay + jitter

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, finalDelay)
  }

  /**
   * Enqueue a message for processing.
   * Handles queue overflow by closing the connection and scheduling a reconnection.
   * @param data - The message data to enqueue.
   * @private
   */
  private enqueueMessage(data: Uint8Array): void {
    if (this.queue.pending.length >= this.options.maxActorQueueSize) {
      this.options.onError?.(
        new Error(`Queue overflow for actor ${this.did}, dropping connection`),
      )
      this.closeAndReconnect()
      return
    }

    this.queue.pending.push(data)
    this.options.onGlobalPendingChange?.(1)

    if (!this.queue.draining) {
      void this.drainQueue()
    }
  }

  /**
   * Close the WebSocket connection and schedule a reconnection attempt.
   * Handles cleanup and ensures the actor is ready for reconnection.
   * @private
   */
  private closeAndReconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.scheduleReconnect()
  }

  /**
   * Drain the message queue and process messages.
   * Handles draining and synchronization logic.
   * @private
   */
  private async drainQueue(): Promise<void> {
    if (this.queue.draining || this.queue.pending.length === 0) return

    this.queue.draining = true
    try {
      while (this.queue.pending.length > 0) {
        if (!this.options.canStartSync()) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.drainDelayMs),
          )
          continue
        }

        const data = this.queue.pending.shift()!
        this.options.onGlobalPendingChange?.(-1)

        this.options.onSyncStarted()
        try {
          await this.handleMessage(data)
        } finally {
          this.options.onSyncFinished()
        }
      }
    } finally {
      this.queue.draining = false
    }
  }

  /**
   * Process a single commit message.
   * Handles commit processing and error handling.
   * @param data - The commit message data.
   * @private
   */
  private async handleMessage(data: Uint8Array): Promise<void> {
    try {
      const commit = decodeXrpcFrame(data)
      if (commit) {
        await this.processCommit(commit)
      }
    } catch (err) {
      this.options.onError?.(err as Error)
    }
  }

  /**
   * Process a single operation within a commit.
   * Handles record upserts and deletions.
   * @param op - The operation to process.
   * @private
   */
  private processOp(op: StratosSyncCommit['ops'][0]): {
    upsert?: RecordUpsert
    delete?: string
  } {
    const uri = `at://${this.did}/${op.path}`
    if (op.action === 'create' || op.action === 'update') {
      if (op.record && op.cid) {
        const upsert = {
          uri,
          cid: op.cid,
          record: op.record as Record<string, unknown>,
          trace: op.trace,
        }
        // Extract referenced DIDs for discovery
        const referenced = extractReferencedDids(op.record)
        for (const ref of referenced) {
          this.options.onReferencedActor?.(ref)
        }
        if (op.path.startsWith('zone.stratos.actor.enrollment/')) {
          this.options.onHandleNeeded?.(this.did)
        }
        return { upsert }
      }
    } else if (op.action === 'delete') {
      return { delete: uri }
    }
    return {}
  }

  /**
   * Process a single commit message.
   * Handles commit processing and error handling.
   * @param commit - The commit message data.
   * @private
   */
  private async processCommit(commit: StratosSyncCommit): Promise<void> {
    const upserts: RecordUpsert[] = []
    const deletes: string[] = []

    for (const op of commit.ops) {
      const { upsert, delete: del } = this.processOp(op)
      if (upsert) upserts.push(upsert)
      if (del) deletes.push(del)
    }

    if (upserts.length > 0 || deletes.length > 0) {
      await batchIndexStratosRecords(this.db, upserts, deletes, commit.time)
      this.options.onIndexed?.(upserts.length)
      this.options.onDeleted?.(deletes.length)
    }

    this.cursorManager.updateStratosCursor(this.did, commit.seq)
  }
}

// --- Utilities (moved from stratos-sync.ts or duplicated if small) ---

/**
 * Build a WebSocket URL for the given service URL and parameters
 * @param serviceUrl - Service URL
 * @param params - Query parameters
 * @returns WebSocket URL
 */
function buildWsUrl(serviceUrl: string, params: StratosSyncParams): string {
  const url = new URL(serviceUrl.replace(/^http/, 'ws'))
  url.pathname = '/xrpc/zone.stratos.sync.subscribeRecords'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/**
 * Decode an XRPC frame into a StratosSyncCommit if it's a commit frame.
 * Returns null if the frame is not a commit or if decoding fails.
 * @param data - The raw frame data.
 * @returns The decoded commit or null if not a commit or decoding fails.
 */
function decodeXrpcFrame(data: Uint8Array): StratosSyncCommit | null {
  try {
    const frame = decodeFirst(data) as XrpcFrame
    if (frame.t === '#commit') {
      return frame as unknown as StratosSyncCommit
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract referenced DIDs from a Stratos record.
 * @param record - The record to extract DIDs from.
 * @returns An array of referenced DIDs.
 */
function extractReferencedDids(record: unknown): string[] {
  const dids = new Set<string>()
  const walk = (val: unknown) => {
    if (!val || typeof val !== 'object') return
    const obj = val as Record<string, unknown>
    if (typeof obj.did === 'string' && obj.did.startsWith('did:')) {
      dids.add(obj.did)
    }
    if (
      obj.$link &&
      typeof obj.$link === 'string' &&
      obj.$link.startsWith('did:')
    ) {
      // link can be did? normally it is a CID string link.
    }
    for (const key in obj) {
      walk(obj[key])
    }
  }
  walk(record)
  return Array.from(dids)
}

/**
 * Batch index Stratos records in the database
 * @param db - Database instance
 * @param upserts - Records to upsert
 * @param deletes - Records to delete
 * @param timestamp - Indexing timestamp
 */
async function batchIndexStratosRecords(
  db: Kysely<StratosIndexerSchema>,
  upserts: RecordUpsert[],
  deletes: string[],
  timestamp: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    for (const uri of deletes) {
      await tx.deleteFrom('stratos_record').where('uri', '=', uri).execute()
    }

    for (const upsert of upserts) {
      const { uri, cid, record, trace } = upsert
      const boundaries = extractBoundaries(record)

      if (trace?.queuedAtMs) {
        const lag = Date.now() - trace.queuedAtMs
        if (lag > INDEX_TRACE_WARN_LAG_MS) {
          // Log lag if needed
        }
      }

      const postRow = preparePostRow(uri, cid, record, timestamp)
      if (postRow) {
        await tx
          .insertInto('post')
          .values(postRow)
          .onConflict((oc) =>
            oc.column('uri').doUpdateSet({
              cid: postRow.cid,
              content: (postRow as unknown as PostTable).content,
              indexedAt: (postRow as unknown as PostTable).indexedAt,
            }),
          )
          .execute()
      }

      await tx
        .insertInto('stratos_record')
        .values({
          uri,
          cid,
          json: JSON.stringify(record),
          indexedAt: timestamp,
        })
        .onConflict((oc) =>
          oc.column('uri').doUpdateSet({
            cid,
            json: JSON.stringify(record),
            indexedAt: timestamp,
          }),
        )
        .execute()

      await tx
        .deleteFrom('stratos_record_boundary')
        .where('uri', '=', uri)
        .execute()

      if (boundaries.length > 0) {
        await tx
          .insertInto('stratos_record_boundary')
          .values(
            boundaries.map((boundary) => ({
              uri,
              boundary,
            })),
          )
          .execute()
      }
    }
  })
}

/**
 * Prepare a post row for insertion into the database
 * @param uri - Post URI
 * @param cid - Content identifier
 * @param record - Post record
 * @param timestamp - Indexing timestamp
 * @returns Prepared post row or null if record is not a post
 */
function preparePostRow(
  uri: string,
  cid: string,
  record: Record<string, unknown>,
  timestamp: string,
): PostTable | null {
  if (record.$type !== STRATOS_POST_COLLECTION) return null
  return {
    uri,
    cid,
    creator: didFromUri(uri),
    content: (record.text as string) || '',
    createdAt: (record.createdAt as string) || timestamp,
    indexedAt: timestamp,
  }
}

/**
 * Extract the DID from a URI string.
 * @param uri - The URI string.
 * @returns The extracted DID.
 */
function didFromUri(uri: string): string {
  const parts = uri.split('/')
  return parts[2]
}
