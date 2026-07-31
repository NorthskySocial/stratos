/**
 * Thin fetch wrapper for the admin surface. Auth is entirely the HttpOnly
 * session cookie from the admin OAuth flow: every request sends
 * `credentials: 'include'`, and there is no Authorization header or stored
 * token. A 401 (no session) or 403 (CSRF origin screen) flips the app back to
 * the unauthenticated state via the registered handler.
 */

export interface WhoamiResponse {
  did: string
  isAdmin: boolean
}

export interface HealthResponse {
  status: string
  version?: string
  /** Per-component status strings, e.g. `{ db: 'ok', blobstore: 'ok' }`. */
  components?: Record<string, string>
}

export interface ListDomainsResponse {
  domains: string[]
}

export interface ResolveEnrollmentsResponse {
  did: string
  enrolled: boolean
  boundaries: string[]
}

export interface EnrollmentStatusResponse {
  did: string
  enrolled: boolean
  enrolledAt?: string
  active?: boolean
  signingKey?: string
  enrollmentRkey?: string
  boundaries?: string[]
}

export interface EnrollmentSummary {
  did: string
  enrolledAt: string
  active: boolean
  isService: boolean
  boundaries: string[]
}

export interface ListEnrollmentsResponse {
  enrollments: EnrollmentSummary[]
  cursor?: string
  total?: number
}

export interface BoundariesResponse {
  did: string
  boundaries: string[]
  /**
   * 'failed' when the boundary change persisted locally but the member's PDS
   * enrollment record could not be rewritten.
   */
  pdsSync?: 'ok' | 'failed'
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let unauthorizedHandler: (() => void) | null = null

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { notifyUnauthorized?: boolean } = {},
): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init })

  if (res.status === 401 || res.status === 403) {
    if (opts.notifyUnauthorized !== false) {
      unauthorizedHandler?.()
    }
    throw new ApiError(res.status, await errorMessage(res))
  }
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res))
  }
  return (await res.json()) as T
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string }
    return body.message || body.error || res.statusText
  } catch {
    return res.statusText
  }
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function whoami(): Promise<WhoamiResponse> {
  return request<WhoamiResponse>(
    '/admin/whoami',
    {},
    { notifyUnauthorized: false },
  )
}

export function logout(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/admin/oauth/logout', {
    method: 'POST',
  })
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

export function listDomains(): Promise<ListDomainsResponse> {
  return request<ListDomainsResponse>('/xrpc/zone.stratos.server.listDomains')
}

export function listEnrollments(
  options: { limit?: number; cursor?: string; boundary?: string } = {},
): Promise<ListEnrollmentsResponse> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor !== undefined) params.set('cursor', options.cursor)
  if (options.boundary !== undefined) params.set('boundary', options.boundary)
  const query = params.toString()
  return request<ListEnrollmentsResponse>(
    `/xrpc/zone.stratos.admin.listEnrollments${query ? `?${query}` : ''}`,
  )
}

export function resolveEnrollments(
  did: string,
): Promise<ResolveEnrollmentsResponse> {
  return request<ResolveEnrollmentsResponse>(
    `/xrpc/zone.stratos.identity.resolveEnrollments?did=${encodeURIComponent(did)}`,
  )
}

export function getEnrollmentStatus(
  did: string,
): Promise<EnrollmentStatusResponse> {
  return request<EnrollmentStatusResponse>(
    `/xrpc/zone.stratos.enrollment.status?did=${encodeURIComponent(did)}`,
  )
}

export function addBoundary(
  did: string,
  boundary: string,
): Promise<BoundariesResponse> {
  return post<BoundariesResponse>('/xrpc/zone.stratos.admin.addBoundary', {
    did,
    boundary,
  })
}

export function removeBoundary(
  did: string,
  boundary: string,
): Promise<BoundariesResponse> {
  return post<BoundariesResponse>('/xrpc/zone.stratos.admin.removeBoundary', {
    did,
    boundary,
  })
}

export function setBoundaries(
  did: string,
  boundaries: string[],
): Promise<BoundariesResponse> {
  return post<BoundariesResponse>('/xrpc/zone.stratos.admin.setBoundaries', {
    did,
    boundaries,
  })
}
