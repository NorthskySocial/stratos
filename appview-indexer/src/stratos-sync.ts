import { WebSocket } from 'partysocket'
import type { Kysely } from '@atproto/bsky/dist/data-plane/server/db/types'
import type { DatabaseSchemaType } from '@atproto/bsky/dist/data-plane/server/db/database-schema'

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

    this.ws.onmessage = (e: MessageEvent) => {
      void this.handleMessage(e.data)
    }

    this.ws.onerror = (e: Event & { error?: unknown }) => {
      this.onError?.(
        new Error('Stratos service subscription error', { cause: e.error }),
      )
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const text =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data as ArrayBuffer)
      const msg = JSON.parse(text) as { $type?: string } & Record<
        string,
        unknown
      >

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
  private cursors = new Map<string, number>()
  private running = false

  constructor(
    private db: Kysely<DatabaseSchemaType>,
    private config: StratosSyncConfig,
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
      this.cursors.set(did, cursor)
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
  }

  getActiveActors(): string[] {
    return Array.from(this.subscriptions.keys())
  }

  private subscribe(did: string, attempt = 0): void {
    if (!this.running) return

    const cursor = this.cursors.get(did)
    const params: Record<string, string> = {
      did,
      syncToken: this.config.syncToken,
    }
    if (cursor !== undefined) {
      params.cursor = String(cursor)
    }

    const wsUrl = buildWsUrl(this.config.stratosServiceUrl, params)
    const ws = new WebSocket(wsUrl)
    this.subscriptions.set(did, ws)

    ws.onmessage = (e: MessageEvent) => {
      void this.handleMessage(did, e.data)
    }

    ws.addEventListener('close', () => {
      this.subscriptions.delete(did)
      this.scheduleReconnect(did, attempt)
    })

    ws.addEventListener('error', (err) => {
      this.onError?.(
        new Error(`Stratos actor sync error for ${did}`, { cause: err }),
      )
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

  private async handleMessage(did: string, data: unknown): Promise<void> {
    try {
      const text =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data as ArrayBuffer)
      const msg = JSON.parse(text) as { $type?: string } & Record<
        string,
        unknown
      >

      if (msg.$type === '#info') {
        const name = (msg as { name?: string }).name
        if (name === 'OutdatedCursor') {
          // TODO: trigger full repo import
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
      const collection = op.path.split('/')[0]
      if (collection !== STRATOS_POST_COLLECTION) continue

      const uri = `at://${did}/${op.path}`

      if (op.action === 'create' || op.action === 'update') {
        if (op.record) {
          await indexStratosRecord(
            this.db,
            uri,
            op.cid ?? '',
            op.record,
            commit.time,
          )
        }
      } else if (op.action === 'delete') {
        await deleteStratosRecord(this.db, uri)
      }
    }

    this.cursors.set(did, commit.seq)
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

  await db.transaction().execute(async (tx) => {
    await tx
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
      .onConflict((oc) =>
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

    await tx
      .deleteFrom('stratos_post_boundary' as never)
      .where('uri' as never, '=', uri)
      .execute()

    if (boundaries.length > 0) {
      await tx
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
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom('stratos_post_boundary' as never)
      .where('uri' as never, '=', uri)
      .execute()
    await tx
      .deleteFrom('stratos_post' as never)
      .where('uri' as never, '=', uri)
      .execute()
  })
}

function extractBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}

// --- Shared utilities ---

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
