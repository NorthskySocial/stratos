import { WebSocket } from 'partysocket'
import { decodeFirst } from '@atcute/cbor'
import type { Kysely } from '@atproto/bsky/dist/data-plane/server/db/types'
import type { DatabaseSchemaType } from '@atproto/bsky/dist/data-plane/server/db/database-schema'
import type { CursorManager } from './cursor-manager.ts'
import { extractBoundaries } from './record-decoder.ts'

const STRATOS_POST_COLLECTION = 'zone.stratos.feed.post'
const MAX_RECONNECT_DELAY_MS = 60_000

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

    this.ws.onmessage = (e: MessageEvent) => {
      void this.handleMessage(new Uint8Array(e.data as ArrayBuffer))
    }

    this.ws.onerror = (e: Event & { error?: unknown }) => {
      const cause =
        e.error instanceof Error ? e.error.message : String(e.error ?? 'unknown')
      this.onError?.(
        new Error(`service subscription ws error: ${cause}`),
      )
    }

    this.ws.onclose = (e: { code: number; reason: string }) => {
      if (e.code !== 1000) {
        this.onError?.(
          new Error(
            `service subscription ws closed: code=${e.code} reason=${e.reason || 'none'}`,
          ),
        )
      }
    }
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

export class StratosActorSync {
  private subscriptions = new Map<string, WebSocket>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = false

  constructor(
    private db: Kysely<DatabaseSchemaType>,
    private config: StratosSyncConfig,
    private cursorManager: CursorManager,
    private onError?: (err: Error) => void,
  ) {}

  start(): void {
    this.running = true
  }

  stop(): void {
    this.running = false

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()

    for (const ws of this.subscriptions.values()) {
      ws.close()
    }
    this.subscriptions.clear()
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
    this.cursorManager.removeStratosCursor(did)
  }

  getActiveActors(): string[] {
    return Array.from(this.subscriptions.keys())
  }

  private subscribe(did: string, attempt = 0): void {
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

    ws.onmessage = (e: MessageEvent) => {
      void this.handleMessage(did, new Uint8Array(e.data as ArrayBuffer))
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
      this.scheduleReconnect(did, attempt)
    })

    ws.addEventListener('error', (e: Event & { error?: unknown }) => {
      const cause =
        e instanceof Error
          ? e.message
          : (e as { error?: unknown }).error ?? 'unknown'
      this.onError?.(new Error(`actor sync ws error for ${did}: ${cause}`))
    })
  }

  private scheduleReconnect(did: string, attempt: number): void {
    if (!this.running) return

    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(did)
      void this.subscribe(did, attempt + 1)
    }, delay)
    this.reconnectTimers.set(did, timer)
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
    for (const op of commit.ops) {
      const trimmedPath = op.path.replace(/^\//, '')
      const collection = trimmedPath.split('/')[0]
      if (collection !== STRATOS_POST_COLLECTION) continue

      const uri = `at://${did}/${trimmedPath}`

      if (op.action === 'create' || op.action === 'update') {
        if (op.record) {
          await indexStratosRecord(this.db, uri, op.cid ?? '', op.record, commit.time)
          console.log(`indexed record: uri=${uri} cid=${op.cid} seq=${commit.seq}`)
        }
      } else if (op.action === 'delete') {
        await deleteStratosRecord(this.db, uri)
        console.log(`deleted record: uri=${uri} seq=${commit.seq}`)
      }
    }

    this.cursorManager.updateStratosCursor(did, commit.seq)
  }
}

// --- Stratos record indexer ---

export async function indexStratosRecord(
  db: Kysely<DatabaseSchemaType>,
  uri: string,
  cid: string,
  record: Record<string, unknown>,
  timestamp: string,
): Promise<void> {
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

  const embed = record.embed ? JSON.stringify(record.embed) : null
  const facets = record.facets ? JSON.stringify(record.facets) : null
  const labels = record.labels ? JSON.stringify(record.labels) : null
  const langs = Array.isArray(record.langs)
    ? (record.langs as string[]).join(',')
    : null
  const tags = Array.isArray(record.tags)
    ? (record.tags as string[]).join(',')
    : null
  const boundaries = extractBoundaries(record)

  await db.transaction().execute(async (tx: unknown) => {
    const trx = tx as Kysely<DatabaseSchemaType>
    await trx
      .insertInto('stratos_post' as never)
      .values({
        uri,
        cid,
        rkey,
        creator,
        text,
        replyRoot: replyRef?.root?.uri ?? null,
        replyRootCid: replyRef?.root?.cid ?? null,
        replyParent: replyRef?.parent?.uri ?? null,
        replyParentCid: replyRef?.parent?.cid ?? null,
        embed,
        facets,
        langs,
        labels,
        tags,
        createdAt,
        indexedAt: timestamp,
      } as never)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onConflict((oc: any) =>
        oc.column('uri' as never).doUpdateSet({
          cid,
          text,
          embed,
          facets,
          langs,
          labels,
          tags,
          indexedAt: timestamp,
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
  })
}

export async function deleteStratosRecord(
  db: Kysely<DatabaseSchemaType>,
  uri: string,
): Promise<void> {
  await db.transaction().execute(async (tx: unknown) => {
    const trx = tx as Kysely<DatabaseSchemaType>
    await trx
      .deleteFrom('stratos_post_boundary' as never)
      .where('uri' as never, '=', uri)
      .execute()
    await trx
      .deleteFrom('stratos_post' as never)
      .where('uri' as never, '=', uri)
      .execute()
  })
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
