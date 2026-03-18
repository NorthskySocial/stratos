import { decodeFirst } from '@atcute/cbor'
import type { Kysely } from '@atproto/bsky/dist/data-plane/server/db/types'
import type { DatabaseSchemaType } from '@atproto/bsky/dist/data-plane/server/db/database-schema'
import type { CursorManager } from './cursor-manager.ts'
import { extractBoundaries } from './record-decoder.ts'

const STRATOS_POST_COLLECTION = 'zone.stratos.feed.post'
const MAX_RECONNECT_DELAY_MS = 60_000
const MAX_RECONNECT_ATTEMPTS = 20

export interface StratosSyncConfig {
  stratosServiceUrl: string
  syncToken: string
}

interface StratosCommitMessage {
  seq: number
  did: string
  time: string
  rev: string
  ops: StratosRecordOp[]
}

interface StratosRecordOp {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: Record<string, unknown>
}

interface EnrollmentMessage {
  did: string
  action: 'enroll' | 'unenroll'
  service?: string
  boundaries?: string[]
  time: string
}

export interface StratosSyncCallbacks {
  onEnroll: (did: string, boundaries: string[]) => void
  onUnenroll: (did: string) => void
}

// --- Service-level enrollment stream ---

export class StratosServiceSubscription {
  private ws: WebSocket | null = null
  private running = false
  private reconnectAttempt = 0

  constructor(
    private config: StratosSyncConfig,
    private callbacks: StratosSyncCallbacks,
    private onError?: (err: Error) => void,
  ) {}

  start(): void {
    this.running = true
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private connect(): void {
    if (!this.running) return

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl, {
      syncToken: this.config.syncToken,
    })

    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0
    })

    this.ws.onmessage = (e: MessageEvent) => {
      void this.handleMessage(new Uint8Array(e.data as ArrayBuffer))
    }

    this.ws.onerror = (e: Event & { error?: unknown }) => {
      const cause =
        e.error instanceof Error
          ? e.error.message
          : String(e.error ?? 'unknown')
      this.onError?.(new Error(`service subscription ws error: ${cause}`))
    }

    this.ws.onclose = (e: { code: number; reason: string }) => {
      if (e.code !== 1000) {
        this.onError?.(
          new Error(
            `service subscription ws closed: code=${e.code} reason=${e.reason || 'none'}`,
          ),
        )
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return

    this.reconnectAttempt++
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    )
    setTimeout(() => this.connect(), delay)
  }

  private async handleMessage(data: Uint8Array): Promise<void> {
    try {
      const msg = decodeXrpcFrame(data)
      if (!msg) return

      if (
        msg.$type === '#enrollment' ||
        msg.$type === 'zone.stratos.sync.subscribeRecords#enrollment'
      ) {
        const enrollment = msg as unknown as EnrollmentMessage
        if (enrollment.action === 'enroll') {
          this.callbacks.onEnroll(enrollment.did, enrollment.boundaries ?? [])
        } else if (enrollment.action === 'unenroll') {
          this.callbacks.onUnenroll(enrollment.did)
        }
      }
    } catch (err) {
      this.onError?.(
        new Error('failed to process Stratos enrollment message', {
          cause: err,
        }),
      )
    }
  }
}

// --- Per-actor record streams ---

export interface StratosActorSyncOptions {
  maxConcurrentActorSyncs: number
  maxActorQueueSize: number
  globalMaxPending: number
  drainDelayMs: number
}

interface ActorQueue {
  pending: Uint8Array[]
  active: boolean
  draining: boolean
}

export class StratosActorSync {
  private subscriptions = new Map<string, WebSocket>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private reconnectAttempts = new Map<string, number>()
  private running = false
  private knownDids = new Map<string, number>()
  private knownDidsSweepTimer: ReturnType<typeof setInterval> | null = null
  private static readonly KNOWN_DIDS_TTL_MS = 30 * 60 * 1000
  private static readonly KNOWN_DIDS_SWEEP_MS = 60 * 1000

  // Per-actor bounded queues prevent unbounded concurrent DB operations during spikes
  private actorQueues = new Map<string, ActorQueue>()
  private activeSyncs = 0
  private syncWaiters: Array<() => void> = []
  private readonly maxConcurrentActorSyncs: number
  private readonly maxActorQueueSize: number
  private readonly globalMaxPending: number
  private readonly drainDelayMs: number
  private globalPendingCount = 0

  // Periodic stats instead of per-record logging
  private indexedCount = 0
  private deletedCount = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private static readonly STATS_INTERVAL_MS = 10_000

  constructor(
    private db: Kysely<DatabaseSchemaType>,
    private config: StratosSyncConfig,
    private cursorManager: CursorManager,
    private onError?: (err: Error) => void,
    private onReferencedActor?: (did: string) => void,
    options: StratosActorSyncOptions = {
      maxConcurrentActorSyncs: 8,
      maxActorQueueSize: 10,
      globalMaxPending: 500,
      drainDelayMs: 5,
    },
    private onHandleNeeded?: (did: string) => void,
  ) {
    this.maxConcurrentActorSyncs = options.maxConcurrentActorSyncs
    this.maxActorQueueSize = options.maxActorQueueSize
    this.globalMaxPending = options.globalMaxPending
    this.drainDelayMs = options.drainDelayMs
  }

  start(): void {
    this.running = true
    this.statsTimer = setInterval(() => {
      if (this.indexedCount > 0 || this.deletedCount > 0) {
        console.log(
          {
            indexed: this.indexedCount,
            deleted: this.deletedCount,
            activeActors: this.subscriptions.size,
          },
          'stratos sync stats',
        )
        this.indexedCount = 0
        this.deletedCount = 0
      }
    }, StratosActorSync.STATS_INTERVAL_MS)

    this.knownDidsSweepTimer = setInterval(() => {
      const cutoff = Date.now() - StratosActorSync.KNOWN_DIDS_TTL_MS
      for (const [did, ts] of this.knownDids) {
        if (ts < cutoff) this.knownDids.delete(did)
      }
    }, StratosActorSync.KNOWN_DIDS_SWEEP_MS)
  }

  stop(): void {
    this.running = false

    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    if (this.knownDidsSweepTimer) {
      clearInterval(this.knownDidsSweepTimer)
      this.knownDidsSweepTimer = null
    }
    this.knownDids.clear()

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()

    for (const ws of this.subscriptions.values()) {
      ws.close()
    }
    this.subscriptions.clear()

    this.actorQueues.clear()
    for (const waiter of this.syncWaiters) waiter()
    this.syncWaiters = []
  }

  addActor(did: string, cursor?: number): void {
    if (this.subscriptions.has(did)) return
    if (cursor !== undefined) {
      this.cursorManager.updateStratosCursor(did, cursor)
    }
    this.subscribe(did)
  }

  removeActor(did: string): void {
    const ws = this.subscriptions.get(did)
    if (ws) {
      ws.close()
      this.subscriptions.delete(did)
    }
    const timer = this.reconnectTimers.get(did)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(did)
    }
    this.reconnectAttempts.delete(did)
    this.cursorManager.removeStratosCursor(did)
    this.actorQueues.delete(did)
  }

  getActiveActors(): string[] {
    return Array.from(this.subscriptions.keys())
  }

  private subscribe(did: string): void {
    if (!this.running) return

    const cursor = this.cursorManager.getStratosCursor(did)
    const params: Record<string, string> = {
      did,
      syncToken: this.config.syncToken,
    }
    if (cursor !== undefined) {
      params.cursor = String(cursor)
    }

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl, params)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    this.subscriptions.set(did, ws)

    ws.addEventListener('open', () => {
      this.reconnectAttempts.delete(did)
    })

    ws.onmessage = (e: MessageEvent) => {
      this.enqueueActorMessage(did, new Uint8Array(e.data as ArrayBuffer))
    }

    ws.addEventListener('close', (e: { code: number; reason: string }) => {
      this.subscriptions.delete(did)
      if (e.code !== 1000) {
        this.onError?.(
          new Error(
            `actor sync ws closed for ${did}: code=${e.code} reason=${e.reason || 'none'}`,
          ),
        )
      }
      this.scheduleReconnect(did)
    })

    ws.addEventListener('error', (e: Event & { error?: unknown }) => {
      const cause =
        e instanceof Error
          ? e.message
          : ((e as { error?: unknown }).error ?? 'unknown')
      this.onError?.(new Error(`actor sync ws error for ${did}: ${cause}`))
    })
  }

  private scheduleReconnect(did: string): void {
    if (!this.running) return

    const attempt = (this.reconnectAttempts.get(did) ?? 0) + 1
    this.reconnectAttempts.set(did, attempt)

    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      console.warn(
        `max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${did}, giving up`,
      )
      this.reconnectAttempts.delete(did)
      return
    }

    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(did)
      this.subscribe(did)
    }, delay)
    this.reconnectTimers.set(did, timer)
  }

  private enqueueActorMessage(did: string, data: Uint8Array): void {
    let q = this.actorQueues.get(did)
    if (!q) {
      q = { pending: [], active: false, draining: false }
      this.actorQueues.set(did, q)
    }
    if (
      q.pending.length >= this.maxActorQueueSize ||
      this.globalPendingCount >= this.globalMaxPending
    ) {
      this.closeAndReconnectActor(did)
      return
    }
    q.pending.push(data)
    this.globalPendingCount++
    if (!q.active && !q.draining) {
      void this.drainActorQueue(did)
    }
  }

  private closeAndReconnectActor(did: string): void {
    const ws = this.subscriptions.get(did)
    if (ws) {
      ws.close()
      this.subscriptions.delete(did)
    }
    const q = this.actorQueues.get(did)
    if (q) {
      q.pending.length = 0
    }
    this.scheduleReconnect(did)
  }

  private async drainActorQueue(did: string): Promise<void> {
    const q = this.actorQueues.get(did)
    if (!q || q.active || q.draining) return

    q.draining = true

    if (this.activeSyncs >= this.maxConcurrentActorSyncs) {
      await new Promise<void>((resolve) => this.syncWaiters.push(resolve))
    }

    q.active = true
    q.draining = false
    this.activeSyncs++

    try {
      while (true) {
        const current = this.actorQueues.get(did)
        if (!current || current.pending.length === 0) break
        const data = current.pending.shift()!
        this.globalPendingCount--
        await this.handleMessage(did, data)
        if (this.drainDelayMs > 0 && current.pending.length > 0) {
          await new Promise<void>((r) => setTimeout(r, this.drainDelayMs))
        }
      }
    } finally {
      q.active = false
      this.activeSyncs--
      this.syncWaiters.shift()?.()
      const remaining = this.actorQueues.get(did)
      if (remaining && remaining.pending.length > 0 && !remaining.draining) {
        void this.drainActorQueue(did)
      }
    }
  }

  private async handleMessage(did: string, data: Uint8Array): Promise<void> {
    try {
      const msg = decodeXrpcFrame(data)
      if (!msg) return

      if (msg.$type === '#info') {
        const name = (msg as { name?: string }).name
        if (name === 'OutdatedCursor') {
          console.warn(`outdated cursor for ${did}, need full repo import`)
        }
        return
      }

      if (msg.$type === '#commit') {
        const commit = msg as unknown as StratosCommitMessage
        await this.processCommit(did, commit)
      }
    } catch (err) {
      this.onError?.(
        new Error(`failed to process Stratos sync message for ${did}`, {
          cause: err,
        }),
      )
    }
  }

  private async processCommit(
    did: string,
    commit: StratosCommitMessage,
  ): Promise<void> {
    const upserts: Array<{
      uri: string
      cid: string
      record: Record<string, unknown>
    }> = []
    const deletes: string[] = []

    for (const op of commit.ops) {
      const trimmedPath = op.path.replace(/^\//, '')
      const collection = trimmedPath.split('/')[0]
      if (collection !== STRATOS_POST_COLLECTION) continue

      const uri = `at://${did}/${trimmedPath}`

      if ((op.action === 'create' || op.action === 'update') && op.record) {
        upserts.push({ uri, cid: op.cid ?? '', record: op.record })
      } else if (op.action === 'delete') {
        deletes.push(uri)
      }
    }

    if (upserts.length === 0 && deletes.length === 0) return

    // Resolve the post creator's handle if not already known
    if (upserts.length > 0 && !this.knownDids.has(did)) {
      this.knownDids.set(did, Date.now())
      this.onHandleNeeded?.(did)
    }

    await batchIndexStratosRecords(this.db, upserts, deletes, commit.time)

    this.indexedCount += upserts.length
    this.deletedCount += deletes.length

    this.cursorManager.updateStratosCursor(did, commit.seq)

    if (this.onReferencedActor) {
      for (const { record } of upserts) {
        for (const refDid of extractReferencedDids(record)) {
          if (refDid !== did && !this.knownDids.has(refDid)) {
            this.knownDids.set(refDid, Date.now())
            this.onReferencedActor(refDid)
          }
        }
      }
    }
  }
  markKnown(dids: Iterable<string>): void {
    const now = Date.now()
    for (const did of dids) {
      this.knownDids.set(did, now)
    }
  }

  getStats(): {
    knownDids: number
    actorQueues: number
    globalPendingCount: number
    activeSyncs: number
  } {
    return {
      knownDids: this.knownDids.size,
      actorQueues: this.actorQueues.size,
      globalPendingCount: this.globalPendingCount,
      activeSyncs: this.activeSyncs,
    }
  }
}

function extractReferencedDids(record: Record<string, unknown>): string[] {
  const dids: string[] = []

  const reply = record.reply as
    | {
        root?: { uri?: string }
        parent?: { uri?: string }
      }
    | undefined

  if (reply?.root?.uri) {
    const did = didFromUri(reply.root.uri)
    if (did) dids.push(did)
  }
  if (reply?.parent?.uri) {
    const did = didFromUri(reply.parent.uri)
    if (did) dids.push(did)
  }

  const embed = record.embed as
    | { record?: { uri?: string }; $type?: string }
    | undefined

  if (embed?.record?.uri) {
    const did = didFromUri(embed.record.uri)
    if (did) dids.push(did)
  }

  return dids
}

function didFromUri(uri: string): string | null {
  if (!uri.startsWith('at://')) return null
  const authority = uri.slice(5).split('/')[0]
  return authority.startsWith('did:') ? authority : null
}

// --- Stratos record indexer ---

interface RecordUpsert {
  uri: string
  cid: string
  record: Record<string, unknown>
}

function preparePostRow(
  uri: string,
  cid: string,
  record: Record<string, unknown>,
  timestamp: string,
) {
  const parts = uri.replace('at://', '').split('/')
  const creator = parts[0]
  const rkey = parts[2]

  const text = typeof record.text === 'string' ? record.text : ''
  const createdAt =
    typeof record.createdAt === 'string'
      ? record.createdAt
      : new Date().toISOString()

  const replyRef = record.reply as
    | {
        root?: { uri?: string; cid?: string }
        parent?: { uri?: string; cid?: string }
      }
    | undefined

  return {
    row: {
      uri,
      cid,
      rkey,
      creator,
      text,
      replyRoot: replyRef?.root?.uri ?? null,
      replyRootCid: replyRef?.root?.cid ?? null,
      replyParent: replyRef?.parent?.uri ?? null,
      replyParentCid: replyRef?.parent?.cid ?? null,
      embed: record.embed ? JSON.stringify(record.embed) : null,
      facets: record.facets ? JSON.stringify(record.facets) : null,
      langs: Array.isArray(record.langs)
        ? (record.langs as string[]).join(',')
        : null,
      labels: record.labels ? JSON.stringify(record.labels) : null,
      tags: Array.isArray(record.tags)
        ? (record.tags as string[]).join(',')
        : null,
      createdAt,
      indexedAt: timestamp,
    },
    boundaries: extractBoundaries(record),
  }
}

async function batchIndexStratosRecords(
  db: Kysely<DatabaseSchemaType>,
  upserts: RecordUpsert[],
  deletes: string[],
  timestamp: string,
): Promise<void> {
  await db.transaction().execute(async (tx: unknown) => {
    const trx = tx as Kysely<DatabaseSchemaType>

    for (const deleteUri of deletes) {
      await trx
        .deleteFrom('stratos_post_boundary' as never)
        .where('uri' as never, '=', deleteUri)
        .execute()
      await trx
        .deleteFrom('stratos_post' as never)
        .where('uri' as never, '=', deleteUri)
        .execute()
    }

    for (const { uri, cid, record } of upserts) {
      const { row, boundaries } = preparePostRow(uri, cid, record, timestamp)

      await trx
        .insertInto('stratos_post' as never)
        .values(row as never)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .onConflict((oc: any) =>
          oc.column('uri' as never).doUpdateSet({
            cid: row.cid,
            text: row.text,
            replyRoot: row.replyRoot,
            replyRootCid: row.replyRootCid,
            replyParent: row.replyParent,
            replyParentCid: row.replyParentCid,
            embed: row.embed,
            facets: row.facets,
            langs: row.langs,
            labels: row.labels,
            tags: row.tags,
            indexedAt: row.indexedAt,
          } as never),
        )
        .execute()

      await trx
        .deleteFrom('stratos_post_boundary' as never)
        .where('uri' as never, '=', uri)
        .execute()

      if (boundaries.length > 0) {
        await trx
          .insertInto('stratos_post_boundary' as never)
          .values(boundaries.map((boundary) => ({ uri, boundary }) as never))
          .execute()
      }
    }
  })
}

// Keep single-record function for backfill compatibility
export async function indexStratosRecord(
  db: Kysely<DatabaseSchemaType>,
  uri: string,
  cid: string,
  record: Record<string, unknown>,
  timestamp: string,
): Promise<void> {
  await batchIndexStratosRecords(db, [{ uri, cid, record }], [], timestamp)
}

export async function deleteStratosRecord(
  db: Kysely<DatabaseSchemaType>,
  uri: string,
): Promise<void> {
  await batchIndexStratosRecords(db, [], [uri], '')
}

// --- Shared utilities ---

function decodeXrpcFrame(
  data: Uint8Array,
): (Record<string, unknown> & { $type?: string }) | null {
  const [header, remainder] = decodeFirst(data)
  const [body] = decodeFirst(remainder)

  const hdr = header as { op?: number; t?: string }
  if (hdr.op === -1) {
    const err = body as { error?: string; message?: string }
    throw new Error(`xrpc stream error: ${err.error}: ${err.message ?? ''}`)
  }

  if (hdr.op !== 1) return null

  const record = body as Record<string, unknown>
  if (hdr.t) {
    record.$type = hdr.t
  }
  return record
}

function buildWsUrl(
  serviceUrl: string,
  params: Record<string, string>,
): string {
  const url = new URL(
    '/xrpc/zone.stratos.sync.subscribeRecords',
    serviceUrl.replace(/^http/, 'ws'),
  )
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}
