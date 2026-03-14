// Stratos XRPC API helpers

import { STRATOS_URL, loadState } from './config.ts'

async function getBaseUrl(forceLocal = false) {
  if (forceLocal) return 'http://localhost:3100'
  const state = await loadState()
  return state.ngrokUrl || STRATOS_URL
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
export async function enrollmentStatus(
  did: string,
): Promise<{ did: string; enrolled: boolean; enrolledAt?: string }> {
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
    enrolledAt?: string
  }
}

interface CreateRecordResponse {
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

interface GetRecordResponse {
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
export async function tryGetRecord(
  repo: string,
  collection: string,
  rkey: string,
  callerDid?: string,
): Promise<
  | { ok: true; data: GetRecordResponse }
  | { ok: false; status: number; error: string }
> {
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
