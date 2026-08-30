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
  eligible?: boolean
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
   * 'deferred' when the boundary change persisted locally but the member's
   * PDS enrollment record has not been rewritten yet; a background worker
   * retries until it converges.
   */
  pdsSync?: 'ok' | 'deferred'
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

/**
 * Register the callback invoked when the service rejects a request as
 * unauthenticated, so the app can return to the login screen from anywhere.
 * @param handler - Called on a 401 or 403 response
 */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler
}

/**
 * Issue a request carrying the admin session cookie.
 *
 * A 403 is treated like a 401: it is what the CSRF origin screen returns, and
 * to an operator both mean the session is not usable.
 * @param path - Service-relative path
 * @param init - Additional fetch options
 * @param opts - Set `notifyUnauthorized: false` to probe auth without
 * triggering the logged-out transition
 * @returns The parsed JSON body
 * @throws ApiError on any non-2xx response
 */
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

/**
 * Best-effort human-readable message from an error response.
 * @param res - The failed response
 * @returns The service's message, its error code, or the status text
 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string }
    return body.message || body.error || res.statusText
  } catch {
    return res.statusText
  }
}

/**
 * Issue a JSON POST carrying the admin session cookie.
 * @param path - Service-relative path
 * @param body - Value serialized as the request body
 * @returns The parsed JSON body
 */
function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Read the signed-in admin's identity.
 *
 * Does not trigger the logged-out transition on failure: this is the call that
 * *determines* whether a session exists, so a rejection is an expected answer
 * rather than an error.
 * @returns The viewer's DID and admin status
 */
export function whoami(): Promise<WhoamiResponse> {
  return request<WhoamiResponse>(
    '/admin/whoami',
    {},
    { notifyUnauthorized: false },
  )
}

/**
 * End the admin session. The cookie is HttpOnly, so only the service can
 * clear it; the caller must reset its own auth state afterwards.
 * @returns Confirmation the session was cleared
 */
export function logout(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/admin/oauth/logout', {
    method: 'POST',
  })
}

/**
 * Read service health, including per-component status.
 * @returns Overall status, version, and component states
 */
export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

/**
 * List the boundary domains this service accepts.
 * @returns The allowed domains, as full service-qualified values
 */
export function listDomains(): Promise<ListDomainsResponse> {
  return request<ListDomainsResponse>('/xrpc/zone.stratos.server.listDomains')
}

/**
 * List enrolled members, newest page first by DID order.
 * @param options - Page size, resume cursor, and optional boundary/active
 * filters
 * @returns A page of members, a cursor when more follow, and the total when
 * unfiltered
 */
export function listEnrollments(
  options: {
    limit?: number
    cursor?: string
    boundary?: string
    active?: boolean
  } = {},
): Promise<ListEnrollmentsResponse> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor !== undefined) params.set('cursor', options.cursor)
  if (options.boundary !== undefined) params.set('boundary', options.boundary)
  if (options.active !== undefined) params.set('active', String(options.active))
  const query = params.toString()
  return request<ListEnrollmentsResponse>(
    `/xrpc/zone.stratos.admin.listEnrollments${query ? `?${query}` : ''}`,
  )
}

/**
 * Look up a single member's enrollment and boundaries.
 * @param did - The member to read
 * @returns Whether the DID is enrolled, and its boundaries
 */
export function resolveEnrollments(
  did: string,
): Promise<ResolveEnrollmentsResponse> {
  return request<ResolveEnrollmentsResponse>(
    `/xrpc/zone.stratos.identity.resolveEnrollments?did=${encodeURIComponent(did)}`,
  )
}

/**
 * Read a member's enrollment detail, including when they enrolled and whether
 * the enrollment is active.
 * @param did - The member to read
 * @returns The enrollment status record
 */
export function getEnrollmentStatus(
  did: string,
): Promise<EnrollmentStatusResponse> {
  return request<EnrollmentStatusResponse>(
    `/xrpc/zone.stratos.enrollment.status?did=${encodeURIComponent(did)}`,
  )
}

/**
 * Grant a member one additional boundary.
 * @param did - The member to update
 * @param boundary - Full service-qualified boundary value
 * @returns The member's resulting boundaries, and whether the PDS record synced
 */
export function addBoundary(
  did: string,
  boundary: string,
): Promise<BoundariesResponse> {
  return post<BoundariesResponse>('/xrpc/zone.stratos.admin.addBoundary', {
    did,
    boundary,
  })
}

/**
 * Take one boundary away from a member.
 * @param did - The member to update
 * @param boundary - Full service-qualified boundary value
 * @returns The member's resulting boundaries, and whether the PDS record synced
 */
export function removeBoundary(
  did: string,
  boundary: string,
): Promise<BoundariesResponse> {
  return post<BoundariesResponse>('/xrpc/zone.stratos.admin.removeBoundary', {
    did,
    boundary,
  })
}

/**
 * Replace a member's entire boundary set.
 * @param did - The member to update
 * @param boundaries - Full service-qualified boundary values
 * @returns The member's resulting boundaries, and whether the PDS record synced
 */
export function setBoundaries(
  did: string,
  boundaries: string[],
): Promise<BoundariesResponse> {
  return post<BoundariesResponse>('/xrpc/zone.stratos.admin.setBoundaries', {
    did,
    boundaries,
  })
}

/**
 * Activate or deactivate a member. Deactivation is reversible and preserves
 * their boundaries.
 * @param did - The member to update
 * @param active - Whether the enrollment should be active
 * @returns The member's resulting state
 */
export function setActive(
  did: string,
  active: boolean,
): Promise<{ did: string; active: boolean }> {
  return post<{ did: string; active: boolean }>(
    '/xrpc/zone.stratos.admin.setActive',
    { did, active },
  )
}

export interface AdminUser {
  did: string
  /** `config` admins come from the environment and cannot be revoked here. */
  source: 'config' | 'database'
  addedAt?: string
  addedBy?: string
}

export interface ListAdminsResponse {
  admins: AdminUser[]
  viewer: string
}

/**
 * List everyone holding admin access, tagged by whether the grant comes from
 * configuration (not revocable here) or the database.
 * @returns The admins, and the requesting admin's own DID
 */
export function listAdmins(): Promise<ListAdminsResponse> {
  return request<ListAdminsResponse>('/xrpc/zone.stratos.admin.listAdmins')
}

/**
 * Grant admin access to a DID.
 * @param did - The DID to grant access to
 * @returns The granted DID
 */
export function addAdmin(did: string): Promise<{ did: string }> {
  return post<{ did: string }>('/xrpc/zone.stratos.admin.addAdmin', { did })
}

/**
 * Revoke admin access from a DID. Refused for config-provided admins and for
 * the caller's own DID.
 * @param did - The DID to revoke access from
 * @returns The revoked DID
 */
export function removeAdmin(did: string): Promise<{ did: string }> {
  return post<{ did: string }>('/xrpc/zone.stratos.admin.removeAdmin', { did })
}
