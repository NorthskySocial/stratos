/**
 * Configuration for the Stratos feed generator.
 *
 */
export interface FeedgenConfig {
  /** DID of this feed generator service (e.g. `did:web:feedgen.example.com`). */
  feedgenServiceDid: string
  /** Public base URL of this feed generator (used as the DID document service endpoint). */
  feedgenPublicUrl: string
  /** Private signing key for this feed generator's service identity. */
  feedgenSigningKey: string
  /** Base URL this feedgen sends requests to the upstream Stratos service on. May be internal-only. */
  stratosServiceUrl: string
  /**
   * Base URL Stratos verifies the space-surface DPoP `htu` against
   * (its own `STRATOS_PUBLIC_URL`). Defaults to `stratosServiceUrl`. Set this
   * separately when `stratosServiceUrl` is an internal address that differs
   * from Stratos's externally-known origin.
   */
  stratosPublicUrl: string
  /** DID of the upstream Stratos service. */
  stratosServiceDid: string
  /** PLC directory URL used to resolve `did:plc:` issuers. */
  feedgenPlcUrl: string
  /** Allow-list of `lxm` values accepted on inbound service-auth JWTs. */
  feedgenAllowedLxms: readonly string[]
  /** Storage backend selection. */
  storageBackend: StorageBackend
  /** Path to SQLite database file (used when `storageBackend === 'sqlite'`). */
  sqlitePath?: string
  /** Postgres connection URL (used when `storageBackend === 'postgres'`). */
  postgresUrl?: string
  /** Optional Postgres schema name. Defaults to `public` when omitted. */
  postgresSchema?: string
  /** TTL (ms) for cached viewer boundary memberships. */
  boundaryCacheTtlMs: number
  /** Max number of viewer DIDs to cache. */
  boundaryCacheMax: number
}

export type StorageBackend = 'sqlite' | 'postgres'

export const DEFAULT_STORAGE_BACKEND: StorageBackend = 'sqlite'
export const DEFAULT_BOUNDARY_CACHE_TTL_MS = 300_000
export const DEFAULT_BOUNDARY_CACHE_MAX = 10_000

/** Lxms accepted on inbound service-auth JWTs. WP9 will append `getBlob`. */
export const DEFAULT_ALLOWED_LXMS: readonly string[] = [
  'zone.stratos.feedgen.getFeed',
]

export const DEFAULT_PLC_URL = 'https://plc.directory'

export interface FeedgenEnv {
  [key: string]: string | undefined
}

export function loadFeedgenConfig(
  env: FeedgenEnv = process.env,
): FeedgenConfig {
  const storageBackend = parseStorageBackend(env['FEEDGEN_STORAGE_BACKEND'])
  const sqlitePath = env['FEEDGEN_SQLITE_PATH']
  const postgresUrl = env['FEEDGEN_POSTGRES_URL']
  const postgresSchema = env['FEEDGEN_POSTGRES_SCHEMA']

  if (storageBackend === 'sqlite' && !sqlitePath) {
    throw new Error(
      'Missing required env var FEEDGEN_SQLITE_PATH for sqlite backend',
    )
  }
  if (storageBackend === 'postgres' && !postgresUrl) {
    throw new Error(
      'Missing required env var FEEDGEN_POSTGRES_URL for postgres backend',
    )
  }

  const feedgenServiceDid = requireEnv(env, 'FEEDGEN_SERVICE_DID')

  return {
    feedgenServiceDid,
    feedgenPublicUrl: trimTrailingSlash(
      optionalEnv(env, 'FEEDGEN_PUBLIC_URL') ?? didWebToUrl(feedgenServiceDid),
    ),
    feedgenSigningKey: requireEnv(env, 'FEEDGEN_SIGNING_KEY'),
    stratosServiceUrl: trimTrailingSlash(
      requireEnv(env, 'STRATOS_SERVICE_URL'),
    ),
    stratosPublicUrl: trimTrailingSlash(
      optionalEnv(env, 'STRATOS_PUBLIC_URL') ??
        requireEnv(env, 'STRATOS_SERVICE_URL'),
    ),
    stratosServiceDid: requireEnv(env, 'STRATOS_SERVICE_DID'),
    feedgenPlcUrl: trimTrailingSlash(env['FEEDGEN_PLC_URL'] ?? DEFAULT_PLC_URL),
    feedgenAllowedLxms: DEFAULT_ALLOWED_LXMS,
    storageBackend,
    sqlitePath,
    postgresUrl,
    postgresSchema,
    boundaryCacheTtlMs: parsePositiveInt(
      env['FEEDGEN_BOUNDARY_CACHE_TTL_MS'],
      'FEEDGEN_BOUNDARY_CACHE_TTL_MS',
      DEFAULT_BOUNDARY_CACHE_TTL_MS,
    ),
    boundaryCacheMax: parsePositiveInt(
      env['FEEDGEN_BOUNDARY_CACHE_MAX'],
      'FEEDGEN_BOUNDARY_CACHE_MAX',
      DEFAULT_BOUNDARY_CACHE_MAX,
    ),
  }
}

function parsePositiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value} (expected positive integer)`)
  }
  return parsed
}

function parseStorageBackend(value: string | undefined): StorageBackend {
  if (value === undefined || value === '') return DEFAULT_STORAGE_BACKEND
  if (value === 'sqlite' || value === 'postgres') return value
  throw new Error(
    `Invalid FEEDGEN_STORAGE_BACKEND: ${value} (expected 'sqlite' or 'postgres')`,
  )
}

/** Read an optional env var. A blank or whitespace-only value counts as unset. */
function optionalEnv(env: FeedgenEnv, key: string): string | undefined {
  const value = env[key]
  if (!value || value.trim() === '') return undefined
  return value
}

function requireEnv(env: FeedgenEnv, key: string): string {
  const value = env[key]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function didWebToUrl(did: string): string {
  const prefix = 'did:web:'
  if (!did.startsWith(prefix)) {
    throw new Error(
      `Cannot derive public URL from non-did:web DID: ${did} (set FEEDGEN_PUBLIC_URL)`,
    )
  }
  const [host, ...segments] = did.slice(prefix.length).split(':')
  const authority = decodeURIComponent(host)
  const path = segments.map(decodeURIComponent).join('/')
  return path ? `https://${authority}/${path}` : `https://${authority}`
}
