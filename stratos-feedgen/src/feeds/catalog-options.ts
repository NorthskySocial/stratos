export interface BoundaryCatalogOptions {
  mode: 'upstream' | 'static'
  refreshMs: number
  maxAgeMs: number
  requestTimeoutMs: number
  applyTimeoutMs: number
}

export function loadBoundaryCatalogOptions(
  env: Record<string, string | undefined> = process.env,
): BoundaryCatalogOptions {
  const mode = env['FEEDGEN_BOUNDARY_CATALOG_MODE'] ?? 'upstream'
  if (mode !== 'upstream' && mode !== 'static')
    throw new Error('FEEDGEN_BOUNDARY_CATALOG_MODE must be upstream or static')
  const refreshMs = milliseconds(
    env['FEEDGEN_BOUNDARY_CATALOG_REFRESH_MS'],
    30_000,
  )
  const maxAgeMs = milliseconds(
    env['FEEDGEN_BOUNDARY_CATALOG_MAX_AGE_MS'],
    60_000,
  )
  const requestTimeoutMs = milliseconds(
    env['FEEDGEN_BOUNDARY_CATALOG_REQUEST_TIMEOUT_MS'],
    10_000,
  )
  const applyTimeoutMs = milliseconds(
    env['FEEDGEN_BOUNDARY_CATALOG_APPLY_TIMEOUT_MS'],
    120_000,
  )
  if (refreshMs >= maxAgeMs)
    throw new Error(
      'Boundary catalogue refresh must be shorter than maximum age',
    )
  return { mode, refreshMs, maxAgeMs, requestTimeoutMs, applyTimeoutMs }
}

function milliseconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const duration = Number(value)
  if (!Number.isInteger(duration) || duration < 1_000 || duration > 300_000)
    throw new Error(
      'Boundary catalogue durations must be integers from 1000 through 300000 ms',
    )
  return duration
}
