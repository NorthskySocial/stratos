// Admin API helpers shared across E2E phases: session-cookie fetch wrappers,
// boundary read-back, and PDS side-effect polling. The browser login flow
// lives in admin-login.ts so phases that only reuse a stored cookie do not
// load Playwright.

import { PDS_URL, STRATOS_URL } from './config.ts'
import { listPdsRecords } from './stratos.ts'
import { loadState } from './state.ts'

// Mirrors `ADMIN_SESSION_COOKIE` in stratos-service/src/oauth/admin-routes.ts;
// kept in sync manually since the Deno suite does not import the service package.
export const ADMIN_SESSION_COOKIE = 'stratos_admin_session'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

export interface AdminResponse {
  status: number
  body: unknown
}

async function adminBaseUrl(): Promise<string> {
  const state = await loadState()
  return state.ngrokUrl || STRATOS_URL
}

/** POST an admin XRPC procedure with the session cookie. */
export async function adminFetch(
  path: string,
  body: Record<string, unknown>,
  sessionCookie: string | null,
): Promise<AdminResponse> {
  const baseUrl = await adminBaseUrl()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
  }
  if (sessionCookie) {
    headers['Cookie'] = `${ADMIN_SESSION_COOKIE}=${sessionCookie}`
  }
  const res = await fetch(`${baseUrl}/xrpc/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

/** GET an admin XRPC query with the session cookie. */
export async function adminList(
  path: string,
  sessionCookie: string | null,
  query: Record<string, string> = {},
): Promise<AdminResponse> {
  const baseUrl = await adminBaseUrl()
  const headers: Record<string, string> = {
    'ngrok-skip-browser-warning': 'true',
  }
  if (sessionCookie) {
    headers['Cookie'] = `${ADMIN_SESSION_COOKIE}=${sessionCookie}`
  }
  const search = new URLSearchParams(query).toString()
  const res = await fetch(
    `${baseUrl}/xrpc/${path}${search ? `?${search}` : ''}`,
    { headers },
  )
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

/** Read one user's effective boundaries via the admin listEnrollments query. */
export async function adminGetBoundaries(
  did: string,
  sessionCookie: string,
): Promise<string[] | null> {
  const res = await adminList(
    'zone.stratos.admin.listEnrollments',
    sessionCookie,
  )
  const body = res.body as {
    enrollments?: Array<{ did: string; boundaries: string[] }>
  }
  return body.enrollments?.find((e) => e.did === did)?.boundaries ?? null
}

/** Replace a user's boundary set via the admin API. */
export async function adminSetBoundaries(
  did: string,
  boundaries: string[],
  sessionCookie: string,
): Promise<AdminResponse> {
  return await adminFetch(
    'zone.stratos.admin.setBoundaries',
    { did, boundaries },
    sessionCookie,
  )
}

/** Read the boundaries recorded on the user's PDS enrollment record. */
export async function readPdsBoundaries(did: string): Promise<string[] | null> {
  const result = await listPdsRecords(PDS_URL, did, ENROLLMENT_COLLECTION)
  const record = result.records[0]
  if (!record) return null
  const value = record.value as { boundaries?: Array<{ value?: string }> }
  if (!Array.isArray(value.boundaries)) return []
  return value.boundaries
    .map((b) => b.value)
    .filter((v): v is string => typeof v === 'string')
}

/** Poll the PDS until its enrollment record matches the expected boundary set. */
export async function waitForPdsBoundaries(
  did: string,
  expected: string[],
  timeoutMs = 10_000,
): Promise<string[] | null> {
  const want = new Set(expected)
  const deadline = Date.now() + timeoutMs
  let last: string[] | null = null
  while (Date.now() < deadline) {
    last = await readPdsBoundaries(did)
    if (last && last.length === want.size && last.every((b) => want.has(b))) {
      return last
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return last
}
