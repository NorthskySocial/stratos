// AppView XRPC API helpers — for testing the test AppView server

const APPVIEW_URL = Deno.env.get('APPVIEW_URL') ?? 'http://localhost:3200'

/** Register a DID with the AppView (triggers enrollment fetch + actor subscription) */
export async function enrollWithAppview(
  did: string,
): Promise<{ did: string; boundaries: string[]; subscribed: boolean }> {
  const res = await fetch(`${APPVIEW_URL}/admin/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did }),
  })
  if (!res.ok) throw new Error(`AppView enroll failed: ${res.status}`)
  return (await res.json()) as { did: string; boundaries: string[]; subscribed: boolean }
}

export interface FeedViewPost {
  post: {
    uri: string
    cid: string
    author: { did: string; handle: string }
    record: {
      $type: string
      text: string
      createdAt: string
      facets?: unknown[]
      embed?: unknown
      langs?: string[]
      tags?: string[]
    }
    indexedAt: string
  }
}

export interface TimelineResponse {
  feed: FeedViewPost[]
  cursor?: string
}

export interface GetPostResponse {
  post: FeedViewPost
}

export interface DiagnosticsResponse {
  posts: number
  boundaries: number
  enrollments: Array<{ did: string; boundaries: string[] }>
  cursors: Array<{ did: string; seq: number }>
  actorSubscriptions: string[]
  serviceStreamConnected: boolean
}

/** Check AppView health endpoint */
export async function checkAppviewHealth(): Promise<{
  status: string
  version: string
  actors: number
  serviceStream: boolean
}> {
  const res = await fetch(`${APPVIEW_URL}/health`)
  if (!res.ok) throw new Error(`AppView health failed: ${res.status}`)
  return (await res.json()) as {
    status: string
    version: string
    actors: number
    serviceStream: boolean
  }
}

/** Poll AppView health until ready */
export async function waitForAppviewHealthy(
  timeoutMs = 60_000,
  intervalMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  console.log(
    `[appview] Checking ${APPVIEW_URL}/health (timeout: ${timeoutMs}ms)`,
  )
  while (Date.now() < deadline) {
    attempt++
    try {
      const health = await checkAppviewHealth()
      console.log(
        `[appview] Attempt ${attempt}: status=${health.status}, actors=${health.actors}, serviceStream=${health.serviceStream}`,
      )
      if (health.status === 'ok') return
    } catch (err) {
      console.log(
        `[appview] Attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `AppView did not become healthy within ${timeoutMs}ms (${attempt} attempts)`,
  )
}

/** Get AppView diagnostics (posts indexed, enrollments, etc.) */
export async function getAppviewDiagnostics(): Promise<DiagnosticsResponse> {
  const res = await fetch(`${APPVIEW_URL}/diagnostics`)
  if (!res.ok) throw new Error(`Diagnostics failed: ${res.status}`)
  return (await res.json()) as DiagnosticsResponse
}

/** Fetch timeline for a viewer (with boundary filtering) */
export async function getTimeline(
  viewerDid: string,
  opts?: { limit?: number; cursor?: string; boundary?: string },
): Promise<TimelineResponse> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.cursor) params.set('cursor', opts.cursor)
  if (opts?.boundary) params.set('boundary', opts.boundary)

  const res = await fetch(
    `${APPVIEW_URL}/xrpc/zone.stratos.feed.getTimeline?${params}`,
    {
      headers: { Authorization: `Bearer ${viewerDid}` },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getTimeline failed: ${res.status} ${body}`)
  }

  return (await res.json()) as TimelineResponse
}

/** Try to fetch timeline, returning error info on failure */
export async function tryGetTimeline(
  viewerDid: string,
  opts?: { limit?: number; cursor?: string; boundary?: string },
): Promise<
  | { ok: true; data: TimelineResponse }
  | { ok: false; status: number; error: string }
> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.cursor) params.set('cursor', opts.cursor)
  if (opts?.boundary) params.set('boundary', opts.boundary)

  const res = await fetch(
    `${APPVIEW_URL}/xrpc/zone.stratos.feed.getTimeline?${params}`,
    {
      headers: { Authorization: `Bearer ${viewerDid}` },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    return { ok: false, status: res.status, error: body }
  }

  return { ok: true, data: (await res.json()) as TimelineResponse }
}

/** Fetch author feed for a viewer */
export async function getAuthorFeed(
  viewerDid: string,
  actor: string,
  opts?: { limit?: number; cursor?: string; boundary?: string },
): Promise<TimelineResponse> {
  const params = new URLSearchParams({ actor })
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.cursor) params.set('cursor', opts.cursor)
  if (opts?.boundary) params.set('boundary', opts.boundary)

  const res = await fetch(
    `${APPVIEW_URL}/xrpc/zone.stratos.feed.getAuthorFeed?${params}`,
    {
      headers: { Authorization: `Bearer ${viewerDid}` },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getAuthorFeed failed: ${res.status} ${body}`)
  }

  return (await res.json()) as TimelineResponse
}

/** Fetch single post with boundary check */
export async function getPost(
  viewerDid: string,
  uri: string,
): Promise<GetPostResponse> {
  const params = new URLSearchParams({ uri })

  const res = await fetch(
    `${APPVIEW_URL}/xrpc/zone.stratos.feed.getPost?${params}`,
    {
      headers: { Authorization: `Bearer ${viewerDid}` },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`getPost failed: ${res.status} ${body}`)
  }

  return (await res.json()) as GetPostResponse
}

/** Try to fetch single post, returning error on failure */
export async function tryGetPost(
  viewerDid: string,
  uri: string,
): Promise<
  | { ok: true; data: GetPostResponse }
  | { ok: false; status: number; error: string }
> {
  const params = new URLSearchParams({ uri })

  const res = await fetch(
    `${APPVIEW_URL}/xrpc/zone.stratos.feed.getPost?${params}`,
    {
      headers: { Authorization: `Bearer ${viewerDid}` },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    return { ok: false, status: res.status, error: body }
  }

  return { ok: true, data: (await res.json()) as GetPostResponse }
}

/** Fetch timeline without auth (should be rejected) */
export async function getTimelineUnauthenticated(): Promise<{
  ok: boolean
  status: number
  error: string
}> {
  const res = await fetch(
    `${APPVIEW_URL}/xrpc/zone.stratos.feed.getTimeline`,
  )
  const body = await res.text()
  return { ok: res.ok, status: res.status, error: body }
}

/** Wait for the AppView to index at least N posts (with timeout) */
export async function waitForIndexing(
  expectedPosts: number,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<DiagnosticsResponse> {
  const deadline = Date.now() + timeoutMs
  let last: DiagnosticsResponse | undefined
  while (Date.now() < deadline) {
    last = await getAppviewDiagnostics()
    if (last.posts >= expectedPosts) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `AppView did not index ${expectedPosts} posts within ${timeoutMs}ms (got ${last?.posts ?? 0})`,
  )
}
