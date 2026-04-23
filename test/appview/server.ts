#!/usr/bin/env -S deno run -A
/**
 * Standalone Stratos AppView test server.
 *
 * Replicates the essential AppView Stratos pipeline:
 *   1. Subscribes to Stratos service-level enrollment stream
 *   2. Subscribes to per-actor record streams
 *   3. Indexes zone.stratos.feed.post records into PostgreSQL
 *   4. Serves feed endpoints (getTimeline, getAuthorFeed, getPost)
 *
 * Uses simplified Bearer DID auth (matching Stratos dev mode).
 */

import postgres from 'npm:postgres@3.4.5'
import { decodeFirst } from 'npm:@atcute/cbor@1.0.0'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(Deno.env.get('APPVIEW_PORT') ?? '3200')
const STRATOS_URL = Deno.env.get('STRATOS_URL') ?? 'http://localhost:3100'
const PG_URL =
  Deno.env.get('APPVIEW_PG_URL') ??
  'postgres://stratos:stratos@localhost:5432/appview'
const SYNC_TOKEN = Deno.env.get('APPVIEW_SYNC_TOKEN') ?? 'test-sync-token'

const STRATOS_POST_COLLECTION = 'zone.stratos.feed.post'

console.log(
  `[appview] config: port=${PORT} stratos=${STRATOS_URL} pg=${PG_URL}`,
)

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const sql = postgres(PG_URL, { max: 10 })

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS stratos_post (
      uri         TEXT PRIMARY KEY,
      cid         TEXT NOT NULL DEFAULT '',
      rkey        TEXT NOT NULL DEFAULT '',
      creator     TEXT NOT NULL DEFAULT '',
      text        TEXT NOT NULL DEFAULT '',
      "replyRoot"    TEXT,
      "replyRootCid" TEXT,
      "replyParent"  TEXT,
      "replyParentCid" TEXT,
      embed       TEXT,
      facets      TEXT,
      langs       TEXT,
      labels      TEXT,
      tags        TEXT,
      "createdAt" TEXT NOT NULL DEFAULT '',
      "indexedAt"  TEXT NOT NULL DEFAULT '',
      "sortAt"     TEXT GENERATED ALWAYS AS (LEAST("createdAt", "indexedAt")) STORED
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS stratos_post_boundary (
      uri       TEXT NOT NULL,
      boundary  TEXT NOT NULL,
      PRIMARY KEY (uri, boundary)
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS stratos_enrollment (
      did          TEXT PRIMARY KEY,
      "serviceUrl" TEXT NOT NULL DEFAULT '',
      "enrolledAt" TEXT NOT NULL DEFAULT '',
      "lastChecked" TEXT NOT NULL DEFAULT '',
      boundaries   TEXT
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS stratos_sync_cursor (
      did        TEXT PRIMARY KEY,
      seq        INTEGER NOT NULL DEFAULT 0,
      "updatedAt" TEXT NOT NULL DEFAULT ''
    )
  `

  await sql`CREATE INDEX IF NOT EXISTS idx_post_sortAt ON stratos_post ("sortAt" DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_post_creator ON stratos_post (creator, "sortAt" DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_boundary_boundary ON stratos_post_boundary (boundary, uri)`

  console.log('[appview] database migration complete')
}

// ---------------------------------------------------------------------------
// CBOR frame decoding (same approach as stratos-indexer)
// ---------------------------------------------------------------------------

interface FrameHeader {
  op?: number
  t?: string
}

function decodeXrpcFrame(
  data: Uint8Array,
): (Record<string, unknown> & { $type?: string }) | null {
  const [header, remainder] = decodeFirst(data)
  const [body] = decodeFirst(remainder as Uint8Array)

  const hdr = header as FrameHeader
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

// ---------------------------------------------------------------------------
// Record indexer
// ---------------------------------------------------------------------------

function extractBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}

function extractPostMetadata(uri: string, record: Record<string, unknown>) {
  const parts = uri.replace('at://', '').split('/')
  return {
    creator: parts[0],
    rkey: parts[2],
    text: typeof record.text === 'string' ? record.text : '',
    createdAt:
      typeof record.createdAt === 'string'
        ? record.createdAt
        : new Date().toISOString(),
    replyRef: record.reply as
      | {
          root?: { uri?: string; cid?: string }
          parent?: { uri?: string; cid?: string }
        }
      | undefined,
    embed: record.embed ? JSON.stringify(record.embed) : null,
    facets: record.facets ? JSON.stringify(record.facets) : null,
    labels: record.labels ? JSON.stringify(record.labels) : null,
    langs: Array.isArray(record.langs)
      ? (record.langs as string[]).join(',')
      : null,
    tags: Array.isArray(record.tags)
      ? (record.tags as string[]).join(',')
      : null,
    boundaries: extractBoundaries(record),
  }
}

async function indexRecord(
  uri: string,
  cid: string,
  record: Record<string, unknown>,
  timestamp: string,
) {
  const meta = extractPostMetadata(uri, record)

  await sql.begin(async (tx) => {
    await insertOrUpdatePost(tx, uri, cid, timestamp, meta)

    await tx`DELETE FROM stratos_post_boundary WHERE uri = ${uri}`

    for (const b of meta.boundaries) {
      await tx`INSERT INTO stratos_post_boundary (uri, boundary) VALUES (${uri}, ${b})`
    }
  })

  console.log(
    `[indexer] indexed ${uri} boundaries=[${meta.boundaries.join(',')}]`,
  )
}

async function insertOrUpdatePost(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  uri: string,
  cid: string,
  timestamp: string,
  meta: ReturnType<typeof extractPostMetadata>,
) {
  const replyRoot = meta.replyRef?.root?.uri ?? null
  const replyRootCid = meta.replyRef?.root?.cid ?? null
  const replyParent = meta.replyRef?.parent?.uri ?? null
  const replyParentCid = meta.replyRef?.parent?.cid ?? null

  await tx`
      INSERT INTO stratos_post (uri, cid, rkey, creator, text,
        "replyRoot", "replyRootCid", "replyParent", "replyParentCid",
        embed, facets, langs, labels, tags, "createdAt", "indexedAt")
      VALUES (${uri}, ${cid}, ${meta.rkey}, ${meta.creator}, ${meta.text},
        ${replyRoot}, ${replyRootCid},
        ${replyParent}, ${replyParentCid},
        ${meta.embed}, ${meta.facets}, ${meta.langs}, ${meta.labels}, ${meta.tags}, ${meta.createdAt}, ${timestamp})
      ON CONFLICT (uri) DO UPDATE SET
        cid = ${cid}, text = ${meta.text},
        "replyRoot" = ${replyRoot},
        "replyRootCid" = ${replyRootCid},
        "replyParent" = ${replyParent},
        "replyParentCid" = ${replyParentCid},
        embed = ${meta.embed}, facets = ${meta.facets}, langs = ${meta.langs},
        labels = ${meta.labels}, tags = ${meta.tags}, "indexedAt" = ${timestamp}
    `
}

async function deleteRecord(uri: string) {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM stratos_post_boundary WHERE uri = ${uri}`
    await tx`DELETE FROM stratos_post WHERE uri = ${uri}`
  })
  console.log(`[indexer] deleted ${uri}`)
}

// ---------------------------------------------------------------------------
// Enrollment management
// ---------------------------------------------------------------------------

async function upsertEnrollment(enrollment: {
  did: string
  serviceUrl: string
  enrolledAt: string
  boundaries: string[]
}) {
  const now = new Date().toISOString()
  const boundariesJson = JSON.stringify(enrollment.boundaries)
  await sql`
    INSERT INTO stratos_enrollment (did, "serviceUrl", "enrolledAt", "lastChecked", boundaries)
    VALUES (${enrollment.did}, ${enrollment.serviceUrl}, ${enrollment.enrolledAt}, ${now}, ${boundariesJson})
    ON CONFLICT (did) DO UPDATE SET
      "serviceUrl" = ${enrollment.serviceUrl},
      "lastChecked" = ${now},
      boundaries = ${boundariesJson}
  `
}

async function getBoundaries(did: string): Promise<string[]> {
  const rows =
    await sql`SELECT boundaries FROM stratos_enrollment WHERE did = ${did}`
  if (rows.length === 0 || !rows[0].boundaries) {
    // Lazy fetch from Stratos
    return fetchBoundariesFromStratos(did)
  }
  return JSON.parse(rows[0].boundaries as string) as string[]
}

async function fetchBoundariesFromStratos(did: string): Promise<string[]> {
  try {
    const url = `${STRATOS_URL}/xrpc/zone.stratos.enrollment.status?did=${encodeURIComponent(did)}`
    // Authenticate as the DID itself so Stratos returns boundaries
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${did}` },
    })
    if (!res.ok) return []
    const body = (await res.json()) as {
      did: string
      enrolled: boolean
      enrolledAt?: string
      boundaries?: Array<{ value: string }>
    }
    if (!body.enrolled) return []
    const boundaries = (body.boundaries ?? []).map((b) => b.value)
    console.log(
      `[enrollment] fetched boundaries for ${did}: [${boundaries.join(',')}]`,
    )
    await upsertEnrollment({
      did: body.did,
      serviceUrl: STRATOS_URL,
      enrolledAt: body.enrolledAt ?? new Date().toISOString(),
      boundaries,
    })
    void subscribeActor(did)
    return boundaries
  } catch (err) {
    console.error(`[enrollment] failed to fetch for ${did}:`, err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Sync cursor
// ---------------------------------------------------------------------------

async function getSyncCursor(did: string): Promise<number | null> {
  const rows = await sql`SELECT seq FROM stratos_sync_cursor WHERE did = ${did}`
  return rows.length > 0 ? (rows[0].seq as number) : null
}

async function updateSyncCursor(did: string, seq: number) {
  const now = new Date().toISOString()
  await sql`
    INSERT INTO stratos_sync_cursor (did, seq, "updatedAt")
    VALUES (${did}, ${seq}, ${now})
    ON CONFLICT (did) DO UPDATE SET seq = ${seq}, "updatedAt" = ${now}
  `
}

// ---------------------------------------------------------------------------
// WebSocket subscriptions
// ---------------------------------------------------------------------------

const actorSubscriptions = new Map<string, WebSocket>()
const actorReconnectTimers = new Map<string, number>()
let serviceWs: WebSocket | null = null
let serviceReconnectTimer: number | null = null
let running = false

function buildWsUrl(params: Record<string, string>): string {
  const url = new URL(
    '/xrpc/zone.stratos.sync.subscribeRecords',
    STRATOS_URL.replace(/^http/, 'ws'),
  )
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

function connectServiceSubscription(attempt = 0) {
  if (!running) return

  const wsUrl = buildWsUrl({ syncToken: SYNC_TOKEN })
  console.log(`[sync] connecting to service stream: ${wsUrl}`)

  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  serviceWs = ws

  ws.onopen = () => {
    console.log('[sync] service enrollment stream connected')
  }

  ws.onmessage = async (event: MessageEvent) => {
    try {
      const data = new Uint8Array(event.data as ArrayBuffer)
      const msg = decodeXrpcFrame(data)
      if (!msg) return

      const type = msg.$type ?? ''
      if (type.endsWith('#enrollment') || type === '#enrollment') {
        const enrollment = msg as unknown as {
          did: string
          action: string
          boundaries: string[]
          time: string
        }
        console.log(
          `[sync] enrollment event: ${enrollment.action} ${enrollment.did}`,
        )

        if (enrollment.action === 'enroll') {
          await upsertEnrollment({
            did: enrollment.did,
            serviceUrl: STRATOS_URL,
            enrolledAt: enrollment.time ?? new Date().toISOString(),
            boundaries: enrollment.boundaries ?? [],
          })
          void subscribeActor(enrollment.did)
        }
      }
    } catch (err) {
      console.error('[sync] service message error:', err)
    }
  }

  ws.onclose = () => {
    serviceWs = null
    if (!running) return
    const delay = Math.min(1000 * Math.pow(2, attempt), 60_000)
    console.log(`[sync] service stream closed, reconnecting in ${delay}ms`)
    serviceReconnectTimer = setTimeout(
      () => connectServiceSubscription(attempt + 1),
      delay,
    ) as unknown as number
  }

  ws.onerror = (err) => {
    console.warn('[sync] service stream error:', err)
  }
}

async function subscribeActor(did: string, attempt = 0) {
  if (!running) return
  if (actorSubscriptions.has(did)) return

  const cursor = await getSyncCursor(did)
  // Always send cursor (0 for initial sync) to get all historical events
  const cursorValue = cursor ?? 0
  const params: Record<string, string> = {
    did,
    syncToken: SYNC_TOKEN,
    cursor: String(cursorValue),
  }

  const wsUrl = buildWsUrl(params)
  console.log(`[sync] subscribing to actor ${did} cursor=${cursorValue}`)

  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  actorSubscriptions.set(did, ws)

  ws.onopen = () => {
    console.log(`[sync] actor stream connected: ${did}`)
  }

  ws.onmessage = async (event: MessageEvent) => {
    try {
      const data = new Uint8Array(event.data as ArrayBuffer)
      const msg = decodeXrpcFrame(data)
      if (!msg) return

      await handleActorMessage(did, msg)
    } catch (err) {
      console.error(`[sync] actor message error (${did}):`, err)
    }
  }

  ws.onclose = () => {
    actorSubscriptions.delete(did)
    if (!running) return
    const delay = Math.min(1000 * Math.pow(2, attempt), 60_000)
    const timer = setTimeout(() => {
      actorReconnectTimers.delete(did)
      void subscribeActor(did, attempt + 1)
    }, delay) as unknown as number
    actorReconnectTimers.set(did, timer)
  }

  ws.onerror = (err) => {
    console.warn(`[sync] actor stream error (${did}):`, err)
  }
}

async function handleActorMessage(did: string, msg: Record<string, unknown>) {
  const type = msg.$type ?? ''

  if (type.endsWith('#info')) {
    const name = (msg as Record<string, unknown>).name as string | undefined
    if (name === 'OutdatedCursor') {
      console.log(`[sync] outdated cursor for ${did}`)
    }
    return
  }

  if (type.endsWith('#commit')) {
    await handleActorCommit(did, msg)
  }
}

async function handleActorCommit(
  did: string,
  commit: {
    seq: number
    time: string
    ops: Array<{
      action: 'create' | 'update' | 'delete'
      path: string
      cid?: string
      record?: Record<string, unknown>
    }>
  },
) {
  for (const op of commit.ops) {
    const trimmedPath = (op.path as string).replace(/^\//, '')
    const collection = trimmedPath.split('/')[0]
    if (collection !== STRATOS_POST_COLLECTION) continue

    const uri = `at://${did}/${trimmedPath}`
    if ((op.action === 'create' || op.action === 'update') && op.record) {
      await indexRecord(uri, op.cid ?? '', op.record, commit.time)
    } else if (op.action === 'delete') {
      await deleteRecord(uri)
    }
  }

  await updateSyncCursor(did, commit.seq)
}

async function startSync() {
  running = true

  connectServiceSubscription()

  const enrollments = await sql`SELECT did FROM stratos_enrollment`
  for (const row of enrollments) {
    void subscribeActor(row.did as string)
  }
  console.log(`[sync] subscribed to ${enrollments.length} existing actors`)
}

function stopSync() {
  running = false
  if (serviceReconnectTimer) clearTimeout(serviceReconnectTimer)
  serviceWs?.close()
  for (const [, timer] of actorReconnectTimers) clearTimeout(timer)
  actorReconnectTimers.clear()
  for (const [, ws] of actorSubscriptions) ws.close()
  actorSubscriptions.clear()
}

// ---------------------------------------------------------------------------
// HTTP server — feed endpoints
// ---------------------------------------------------------------------------

function extractDid(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (!auth) return null
  const parts = auth.split(' ')
  if (parts[0] !== 'Bearer' || !parts[1]) return null
  return parts[1]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(
  message: string,
  status: number,
  error?: string,
): Response {
  return jsonResponse({ error: error ?? 'InvalidRequest', message }, status)
}

async function handleGetTimeline(req: Request): Promise<Response> {
  const viewer = extractDid(req)
  if (!viewer)
    return errorResponse('Authentication required', 401, 'AuthRequired')

  const url = new URL(req.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100)
  const cursor = url.searchParams.get('cursor') ?? undefined
  const boundaryFilter = url.searchParams.get('boundary') ?? undefined

  let viewerBoundaries = await getBoundaries(viewer)
  if (viewerBoundaries.length === 0) return jsonResponse({ feed: [] })

  if (boundaryFilter) {
    viewerBoundaries = viewerBoundaries.filter((b) => b === boundaryFilter)
  }

  let rows
  if (cursor) {
    rows = await sql`
      SELECT DISTINCT ON (p.uri) p.*
      FROM stratos_post p
      INNER JOIN stratos_post_boundary pb ON p.uri = pb.uri
      WHERE pb.boundary = ANY(${viewerBoundaries})
        AND p."sortAt" < ${cursor}
      ORDER BY p.uri, p."sortAt" DESC
    `
    // Re-sort after DISTINCT ON
    rows = rows
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        (b.sortAt as string).localeCompare(a.sortAt as string),
      )
      .slice(0, limit + 1)
  } else {
    rows = await sql`
      SELECT DISTINCT ON (p.uri) p.*
      FROM stratos_post p
      INNER JOIN stratos_post_boundary pb ON p.uri = pb.uri
      WHERE pb.boundary = ANY(${viewerBoundaries})
      ORDER BY p.uri, p."sortAt" DESC
    `
    rows = rows
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        (b.sortAt as string).localeCompare(a.sortAt as string),
      )
      .slice(0, limit + 1)
  }

  const hasMore = rows.length > limit
  const posts = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore
    ? (posts[posts.length - 1]?.sortAt as string)
    : undefined

  const boundaryMap = await enrichWithBoundaries(posts)
  const feed = posts.map((p) =>
    formatFeedViewPost(p, boundaryMap.get(p.uri as string)),
  )
  return jsonResponse({ feed, cursor: nextCursor })
}

async function handleGetAuthorFeed(req: Request): Promise<Response> {
  const viewer = extractDid(req)
  if (!viewer)
    return errorResponse('Authentication required', 401, 'AuthRequired')

  const url = new URL(req.url)
  const actor = url.searchParams.get('actor')
  if (!actor) return errorResponse('actor parameter required', 400)

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100)
  const cursor = url.searchParams.get('cursor') ?? undefined
  const boundaryFilter = url.searchParams.get('boundary') ?? undefined

  let viewerBoundaries = await getBoundaries(viewer)
  if (viewerBoundaries.length === 0) return jsonResponse({ feed: [] })

  if (boundaryFilter) {
    viewerBoundaries = viewerBoundaries.filter((b) => b === boundaryFilter)
  }

  let rows
  if (cursor) {
    rows = await sql`
      SELECT DISTINCT ON (p.uri) p.*
      FROM stratos_post p
      INNER JOIN stratos_post_boundary pb ON p.uri = pb.uri
      WHERE p.creator = ${actor}
        AND pb.boundary = ANY(${viewerBoundaries})
        AND p."sortAt" < ${cursor}
      ORDER BY p.uri, p."sortAt" DESC
    `
  } else {
    rows = await sql`
      SELECT DISTINCT ON (p.uri) p.*
      FROM stratos_post p
      INNER JOIN stratos_post_boundary pb ON p.uri = pb.uri
      WHERE p.creator = ${actor}
        AND pb.boundary = ANY(${viewerBoundaries})
      ORDER BY p.uri, p."sortAt" DESC
    `
  }

  rows = rows
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      (b.sortAt as string).localeCompare(a.sortAt as string),
    )
    .slice(0, limit + 1)

  const hasMore = rows.length > limit
  const posts = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore
    ? (posts[posts.length - 1]?.sortAt as string)
    : undefined

  const boundaryMap = await enrichWithBoundaries(posts)
  const feed = posts.map((p) =>
    formatFeedViewPost(p, boundaryMap.get(p.uri as string)),
  )
  return jsonResponse({ feed, cursor: nextCursor })
}

async function handleGetPost(req: Request): Promise<Response> {
  const viewer = extractDid(req)
  if (!viewer)
    return errorResponse('Authentication required', 401, 'AuthRequired')

  const url = new URL(req.url)
  const uri = url.searchParams.get('uri')
  if (!uri) return errorResponse('uri parameter required', 400)

  const rows = await sql`SELECT * FROM stratos_post WHERE uri = ${uri}`
  if (rows.length === 0)
    return errorResponse('Post not found', 400, 'PostNotFound')

  const post = rows[0]
  const boundaryRows = await sql`
    SELECT boundary FROM stratos_post_boundary WHERE uri = ${uri}
  `
  const postBoundaries = boundaryRows.map((r) => r.boundary as string)

  const viewerBoundaries = await getBoundaries(viewer)

  if (postBoundaries.length > 0) {
    const hasOverlap = postBoundaries.some((b) => viewerBoundaries.includes(b))
    if (!hasOverlap) {
      return errorResponse(
        'Viewer does not share a boundary with this post',
        400,
        'BoundaryMismatch',
      )
    }
  }

  return jsonResponse({ post: formatFeedViewPost(post, postBoundaries) })
}

function formatFeedViewPost(
  row: Record<string, unknown>,
  boundaries?: string[],
) {
  return {
    post: {
      uri: row.uri,
      cid: row.cid,
      author: { did: row.creator, handle: row.creator },
      record: {
        $type: 'zone.stratos.feed.post',
        text: row.text,
        createdAt: row.createdAt,
        ...(row.replyRoot
          ? {
              reply: {
                root: { uri: row.replyRoot, cid: row.replyRootCid },
                parent: { uri: row.replyParent, cid: row.replyParentCid },
              },
            }
          : {}),
        ...(boundaries && boundaries.length > 0
          ? {
              boundary: {
                $type: 'zone.stratos.boundary.defs#Domains',
                values: boundaries.map((b) => ({ value: b })),
              },
            }
          : {}),
        ...(row.facets ? { facets: JSON.parse(row.facets as string) } : {}),
        ...(row.embed ? { embed: JSON.parse(row.embed as string) } : {}),
        ...(row.langs ? { langs: (row.langs as string).split(',') } : {}),
        ...(row.tags ? { tags: (row.tags as string).split(',') } : {}),
      },
      indexedAt: row.indexedAt,
    },
  }
}

async function enrichWithBoundaries(
  posts: Record<string, unknown>[],
): Promise<Map<string, string[]>> {
  if (posts.length === 0) return new Map()
  const uris = posts.map((p) => p.uri as string)
  const rows = await sql`
    SELECT uri, boundary FROM stratos_post_boundary WHERE uri = ANY(${uris})
  `
  const map = new Map<string, string[]>()
  for (const r of rows) {
    const uri = r.uri as string
    const list = map.get(uri) ?? []
    list.push(r.boundary as string)
    map.set(uri, list)
  }
  return map
}

async function handleHealth(): Promise<Response> {
  try {
    await sql`SELECT 1`
    return jsonResponse({
      status: 'ok',
      version: 'test-appview-1.0.0',
      actors: actorSubscriptions.size,
      serviceStream: serviceWs?.readyState === WebSocket.OPEN,
    })
  } catch {
    return jsonResponse({ status: 'error' }, 503)
  }
}

async function handleDiagnostics(): Promise<Response> {
  const [posts] = await sql`SELECT COUNT(*) as count FROM stratos_post`
  const [boundaries] =
    await sql`SELECT COUNT(*) as count FROM stratos_post_boundary`
  const enrollments = await sql`SELECT did, boundaries FROM stratos_enrollment`
  const cursors = await sql`SELECT did, seq FROM stratos_sync_cursor`

  return jsonResponse({
    posts: posts.count,
    boundaries: boundaries.count,
    enrollments: enrollments.map((e) => ({
      did: e.did,
      boundaries: e.boundaries ? JSON.parse(e.boundaries as string) : [],
    })),
    cursors: cursors.map((c) => ({ did: c.did, seq: c.seq })),
    actorSubscriptions: [...actorSubscriptions.keys()],
    serviceStreamConnected: serviceWs?.readyState === WebSocket.OPEN,
  })
}

async function handleAdminEnroll(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)
  const body = (await req.json()) as { did: string }
  if (!body.did) return errorResponse('did is required', 400)

  const boundaries = await fetchBoundariesFromStratos(body.did)
  return jsonResponse({
    did: body.did,
    boundaries,
    subscribed: actorSubscriptions.has(body.did),
  })
}

function routeRequest(req: Request): Promise<Response> | Response {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/health' || path === '/xrpc/_health') {
    return handleHealth()
  }

  if (path === '/diagnostics') {
    return handleDiagnostics()
  }

  if (path === '/admin/enroll') {
    return handleAdminEnroll(req)
  }

  if (path === '/xrpc/zone.stratos.feed.getTimeline') {
    return handleGetTimeline(req)
  }

  if (path === '/xrpc/zone.stratos.feed.getAuthorFeed') {
    return handleGetAuthorFeed(req)
  }

  if (path === '/xrpc/zone.stratos.feed.getPost') {
    return handleGetPost(req)
  }

  return errorResponse('Not found', 404, 'NotFound')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await migrate()
  await startSync()

  Deno.serve({ port: PORT }, routeRequest)
  console.log(`[appview] listening on :${PORT}`)

  Deno.addSignalListener('SIGTERM', () => {
    console.log('[appview] shutting down...')
    stopSync()
    sql.end()
    Deno.exit(0)
  })
}

main()
