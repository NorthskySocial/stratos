// Stratos XRPC API helpers

import { STRATOS_URL } from './config.ts'

async function getBaseUrl(forceLocal = false) {
  if (forceLocal) return 'http://localhost:3100'
  return STRATOS_URL
}

/** Check Stratos health endpoint */
export async function checkHealth(): Promise<{
  status: string
  version: string
}> {
  const baseUrl = await getBaseUrl(true) // Always use localhost for health
  const url = `${baseUrl}/health`
  const res = await fetch(url)
  const body = await res.text()
  if (!res.ok) throw new Error(`Health check failed: ${res.status} - ${body}`)
  return JSON.parse(body) as { status: string; version: string }
}

/** Poll health endpoint until ready (or timeout) */
export async function waitForHealthy(
  timeoutMs = 60_000,
  intervalMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  const baseUrl = await getBaseUrl(true) // Always use localhost for health
  console.log(`[health] Checking ${baseUrl}/health (timeout: ${timeoutMs}ms)`)
  while (Date.now() < deadline) {
    attempt++
    try {
      const health = await checkHealth()
      console.log(
        `[health] Attempt ${attempt}: status=${health.status}, version=${health.version}`,
      )
      if (health.status === 'ok') return
    } catch (err) {
      console.log(
        `[health] Attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `Stratos did not become healthy within ${timeoutMs}ms (${attempt} attempts)`,
  )
}

/** Check enrollment status (no auth required) */
export async function enrollmentStatus(did: string): Promise<{
  did: string
  enrolled: boolean
  eligible?: boolean
  active?: boolean
  enrolledAt?: string
  enrollmentRkey?: string
  signingKey?: string
}> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.enrollment.status?did=${encodeURIComponent(did)}`,
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Enrollment status failed: ${res.status} ${body}`)
  }
  return (await res.json()) as {
    did: string
    enrolled: boolean
    eligible?: boolean
    active?: boolean
    enrolledAt?: string
    enrollmentRkey?: string
    signingKey?: string
  }
}

export interface CreateRecordResponse {
  uri: string
  cid: string
  commit?: { cid: string; rev: string }
}

/** Create a record on Stratos (requires auth) */
export async function createRecord(
  callerDid: string,
  collection: string,
  record: Record<string, unknown>,
  rkey?: string,
): Promise<CreateRecordResponse> {
  const body: Record<string, unknown> = {
    repo: callerDid,
    collection,
    record,
  }
  if (rkey) body.rkey = rkey

  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${callerDid}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`createRecord failed: ${res.status} ${errBody}`)
  }

  return (await res.json()) as CreateRecordResponse
}

export interface GetRecordResponse {
  uri: string
  cid?: string
  value: Record<string, unknown>
}

/** Get a record from Stratos (optional auth) */
export async function getRecord(
  repo: string,
  collection: string,
  rkey: string,
  callerDid?: string,
): Promise<GetRecordResponse> {
  const params = new URLSearchParams({ repo, collection, rkey })
  const headers: Record<string, string> = {}
  if (callerDid) {
    headers['Authorization'] = `Bearer ${callerDid}`
  }

  const baseUrl = await getBaseUrl()
  const res = await fetch(
    `${baseUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
    { headers },
  )

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`getRecord failed: ${res.status} ${errBody}`)
  }

  return (await res.json()) as GetRecordResponse
}

/** Try to get a record, returns null on error (used for negative tests) */
export type TryGetRecordResult =
  | { ok: true; data: GetRecordResponse }
  | { ok: false; status: number; error: string }

export async function tryGetRecord(
  repo: string,
  collection: string,
  rkey: string,
  callerDid?: string,
): Promise<TryGetRecordResult> {
  const params = new URLSearchParams({ repo, collection, rkey })
  const headers: Record<string, string> = {}
  if (callerDid) {
    headers['Authorization'] = `Bearer ${callerDid}`
  }

  const baseUrl = await getBaseUrl()
  const res = await fetch(
    `${baseUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
    { headers },
  )

  if (!res.ok) {
    const body = await res.text()
    return { ok: false, status: res.status, error: body }
  }

  return { ok: true, data: (await res.json()) as GetRecordResponse }
}

export function isRecordNotFound(result: TryGetRecordResult): boolean {
  if (result.ok || result.status !== 400) return false
  try {
    const body = JSON.parse(result.error) as {
      error?: unknown
      message?: unknown
    }
    return (
      body.error === 'RecordNotFound' && body.message === 'Record not found'
    )
  } catch {
    return false
  }
}

interface ListRecordsResponse {
  records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>
  cursor?: string
}

/** List records from Stratos (optional auth) */
export async function listRecords(
  repo: string,
  collection: string,
  callerDid?: string,
  limit?: number,
): Promise<ListRecordsResponse> {
  const params = new URLSearchParams({ repo, collection })
  if (limit) params.set('limit', String(limit))

  const headers: Record<string, string> = {}
  if (callerDid) {
    headers['Authorization'] = `Bearer ${callerDid}`
  }

  const baseUrl = await getBaseUrl()
  const res = await fetch(
    `${baseUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    { headers },
  )

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`listRecords failed: ${res.status} ${errBody}`)
  }

  return (await res.json()) as ListRecordsResponse
}

/** Delete a record on Stratos (requires auth) */
export async function deleteRecord(
  callerDid: string,
  collection: string,
  rkey: string,
): Promise<void> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}/xrpc/com.atproto.repo.deleteRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${callerDid}`,
    },
    body: JSON.stringify({
      repo: callerDid,
      collection,
      rkey,
    }),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`deleteRecord failed: ${res.status} ${errBody}`)
  }
}

export interface UploadBlobResponse {
  blob: {
    $type: 'blob'
    ref: { $link: string }
    mimeType: string
    size: number
  }
}

/** Upload a blob to Stratos (requires auth) */
export async function uploadBlob(
  callerDid: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): Promise<UploadBlobResponse> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      Authorization: `Bearer ${callerDid}`,
    },
    body: bytes,
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`uploadBlob failed: ${res.status} ${errBody}`)
  }

  return (await res.json()) as UploadBlobResponse
}

/**
 * Fetch a blob via `zone.stratos.sync.getBlob`. Returns the status plus
 * either the blob bytes (success) or the XRPC error name (denial), so
 * callers can assert both paths.
 */
export async function getBlob(
  callerDid: string | null,
  did: string,
  cid: string,
): Promise<{ status: number; bytes: Uint8Array; error?: string }> {
  const baseUrl = await getBaseUrl()
  const params = new URLSearchParams({ did, cid })
  const headers: Record<string, string> = {}
  if (callerDid) headers['Authorization'] = `Bearer ${callerDid}`
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.sync.getBlob?${params}`,
    { headers },
  )

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { status: res.status, bytes: new Uint8Array(0), error: body.error }
  }

  const buf = await res.arrayBuffer()
  return { status: res.status, bytes: new Uint8Array(buf) }
}

interface PdsListRecordsResponse {
  records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>
  cursor?: string
}

/** List records from a user's PDS (unauthenticated, public collection) */
export async function listPdsRecords(
  pdsUrl: string,
  repo: string,
  collection: string,
  signal?: AbortSignal,
): Promise<PdsListRecordsResponse> {
  const params = new URLSearchParams({ repo, collection })
  const res = await fetch(
    `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    { signal },
  )

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`PDS listRecords failed: ${res.status} ${errBody}`)
  }

  return (await res.json()) as PdsListRecordsResponse
}

/** Unenroll from Stratos (requires auth) */
export async function unenroll(callerDid: string): Promise<void> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}/xrpc/zone.stratos.enrollment.unenroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${callerDid}`,
    },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`unenroll failed: ${res.status} ${errBody}`)
  }
}

// ─── Spaces (permissioned-data) helpers ─────────────────────────────────────

export interface SpaceCredentialResponse {
  credential: string
  expiresAt: string
}

/**
 * Request a space credential via `zone.stratos.space.getSpaceCredential`.
 * Identity comes from the (dev-mode) Bearer DID session. Returns the raw
 * response so callers can assert on error statuses/codes as well.
 */
export async function getSpaceCredential(
  callerDid: string | null,
  spaceUri: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const baseUrl = await getBaseUrl()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (callerDid) headers['Authorization'] = `Bearer ${callerDid}`
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.space.getSpaceCredential`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ space: spaceUri }),
    },
  )
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // leave body empty; caller asserts on status
  }
  return { status: res.status, body }
}

/**
 * Hydrate a record presenting a SPACE CREDENTIAL as the bearer (no user
 * identity). Returns status + parsed body for both success and denial paths.
 */
export async function hydrateRecordWithCredential(
  credential: string,
  uri: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const baseUrl = await getBaseUrl()
  const params = new URLSearchParams({ uri })
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.repo.hydrateRecord?${params}`,
    { headers: { Authorization: `Bearer ${credential}` } },
  )
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // leave body empty; caller asserts on status
  }
  return { status: res.status, body }
}

/**
 * Read a record from a space via `zone.stratos.space.getRecord` (spec-shaped
 * mirror of com.atproto.space.getRecord). The bearer may be a user DID
 * (dev mode) or a space credential.
 */
export async function getSpaceRecord(
  bearer: string,
  space: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const baseUrl = await getBaseUrl()
  const params = new URLSearchParams({ space, repo, collection, rkey })
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.space.getRecord?${params}`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  )
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // leave body empty; caller asserts on status
  }
  return { status: res.status, body }
}

export interface RepoOpsResponse {
  ops: Array<{
    rev: string
    collection: string
    rkey: string
    cid: string | null
    prev: string | null
    value?: Record<string, unknown>
  }>
  /** Absent once the response reaches the head of the oplog. */
  cursor?: string
  commit?: {
    did: string
    version: number
    rev: string
    sig?: unknown
    data?: unknown
  }
}

/**
 * Pull-sync a repo's oplog via `zone.stratos.sync.listRepoOps`, authenticating
 * with a space credential.
 */
export async function listRepoOpsWithCredential(
  credential: string,
  did: string,
): Promise<{ status: number; body: RepoOpsResponse }> {
  const baseUrl = await getBaseUrl()
  const params = new URLSearchParams({ did })
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.sync.listRepoOps?${params}`,
    { headers: { Authorization: `Bearer ${credential}` } },
  )
  const body = (await res.json().catch(() => ({}))) as RepoOpsResponse
  return { status: res.status, body }
}

/**
 * Attempt a record write presenting a SPACE CREDENTIAL as the bearer.
 * Credentials are read/sync capabilities; the write path must reject them.
 * Returns the status so the caller can assert the rejection.
 */
export async function createRecordWithCredential(
  credential: string,
  repo: string,
  collection: string,
  record: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const baseUrl = await getBaseUrl()
  const res = await fetch(`${baseUrl}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ repo, collection, record }),
  })
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // leave body empty; caller asserts on status
  }
  return { status: res.status, body }
}

/**
 * Fetch the full repo CAR (`zone.stratos.sync.getRepo`): all record blocks,
 * MST nodes, and the signed commit. Returns status + CAR bytes.
 * (The per-record proof endpoint `com.atproto.sync.getRecord` is documented
 * but not registered by the service - see the enum-only HANDLER_METHOD entry.)
 */
export async function getRepoCar(
  callerDid: string,
  did: string,
): Promise<{ status: number; car: Uint8Array }> {
  const baseUrl = await getBaseUrl()
  const params = new URLSearchParams({ did })
  const res = await fetch(
    `${baseUrl}/xrpc/zone.stratos.sync.getRepo?${params}`,
    {
      headers: { Authorization: `Bearer ${callerDid}` },
    },
  )
  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0))
  return { status: res.status, car: new Uint8Array(buf) }
}
