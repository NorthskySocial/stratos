import { parseCommaList } from '@northskysocial/stratos-core'

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
  /** Pino log level. */
  logLevel: string
  /** Bearer token required on `/metrics`. Unset: the endpoint is open. */
  metricsToken?: string

  /** Whether the space-sync scheduler runs. See `docs/spaces/mixed-mode/MM-06-feedgen-syncer.md`. */
  spaceSyncEnabled: boolean
  /** Target interval (ms) between space-sync passes, before jitter. */
  spaceSyncIntervalMs: number
  /** Rows requested per space-membership enumeration page. */
  spaceMembershipPageLimit: number
  /** Timeout (ms) for one membership listing or credential-mint request. */
  spaceMembershipRequestTimeoutMs: number
  /** Max ops requested per `listRepoOps` page when syncing a member. */
  spaceSyncPageLimit: number
  /** Max pages fetched for one member in one pass. */
  spaceSyncMaxPages: number
  /** Timeout (ms) for a single outbound request to a member's host. */
  spaceSyncRequestTimeoutMs: number
  /** Time budget (ms) for one member in one pass. A member over budget is abandoned for that pass. */
  spaceSyncMemberBudgetMs: number
  /** Maximum number of members synced concurrently in one pass. */
  spaceSyncMemberConcurrency: number
  /** Max accepted size (bytes) of a single record fetched from a member's host. */
  spaceSyncMaxRecordBytes: number
  /** Max records indexed for one member in one pass. */
  spaceSyncMaxRecordsPerMember: number
  /** Exact `http://` origins allowed for member hosts. `https://` origins are always allowed. */
  spaceSyncAllowHttpOrigins: ReadonlySet<string>
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

export const DEFAULT_LOG_LEVEL = 'info'

export const DEFAULT_SPACE_SYNC_ENABLED = true
export const DEFAULT_SPACE_SYNC_INTERVAL_MS = 30_000
export const DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT = 100
export const MAX_SPACE_MEMBERSHIP_PAGE_LIMIT = 1_000
// listRepos may resolve PDS hosts in ten-worker batches; keep headroom above
// the 30s resolver-only worst case for a default 100-row page.
export const DEFAULT_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_SPACE_SYNC_PAGE_LIMIT = 1_000
export const MAX_SPACE_SYNC_PAGE_LIMIT = 1_000
export const DEFAULT_SPACE_SYNC_MAX_PAGES = 10
export const DEFAULT_SPACE_SYNC_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_SPACE_SYNC_MEMBER_BUDGET_MS = 60_000
export const DEFAULT_SPACE_SYNC_MEMBER_CONCURRENCY = 8
export const DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES = 65_536
export const DEFAULT_SPACE_SYNC_MAX_RECORDS_PER_MEMBER = 1_000
export const DEFAULT_SPACE_SYNC_ALLOW_HTTP_ORIGINS: ReadonlySet<string> =
  new Set()

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
    logLevel: nonEmpty(env['FEEDGEN_LOG_LEVEL']) ?? DEFAULT_LOG_LEVEL,
    metricsToken: nonEmpty(env['FEEDGEN_METRICS_TOKEN']),

    spaceSyncEnabled: parseBoolean(
      env['FEEDGEN_SPACE_SYNC_ENABLED'],
      'FEEDGEN_SPACE_SYNC_ENABLED',
      DEFAULT_SPACE_SYNC_ENABLED,
    ),
    spaceSyncIntervalMs: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_INTERVAL_MS'],
      'FEEDGEN_SPACE_SYNC_INTERVAL_MS',
      DEFAULT_SPACE_SYNC_INTERVAL_MS,
    ),
    spaceMembershipPageLimit: parseBoundedPositiveInt(
      env['FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT'],
      'FEEDGEN_SPACE_MEMBERSHIP_PAGE_LIMIT',
      DEFAULT_SPACE_MEMBERSHIP_PAGE_LIMIT,
      MAX_SPACE_MEMBERSHIP_PAGE_LIMIT,
    ),
    spaceMembershipRequestTimeoutMs: parsePositiveInt(
      env['FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS'],
      'FEEDGEN_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS',
      DEFAULT_SPACE_MEMBERSHIP_REQUEST_TIMEOUT_MS,
    ),
    spaceSyncPageLimit: parseSpaceSyncPageLimit(
      env['FEEDGEN_SPACE_SYNC_PAGE_LIMIT'],
    ),
    spaceSyncMaxPages: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_MAX_PAGES'],
      'FEEDGEN_SPACE_SYNC_MAX_PAGES',
      DEFAULT_SPACE_SYNC_MAX_PAGES,
    ),
    spaceSyncRequestTimeoutMs: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_REQUEST_TIMEOUT_MS'],
      'FEEDGEN_SPACE_SYNC_REQUEST_TIMEOUT_MS',
      DEFAULT_SPACE_SYNC_REQUEST_TIMEOUT_MS,
    ),
    spaceSyncMemberBudgetMs: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_MEMBER_BUDGET_MS'],
      'FEEDGEN_SPACE_SYNC_MEMBER_BUDGET_MS',
      DEFAULT_SPACE_SYNC_MEMBER_BUDGET_MS,
    ),
    spaceSyncMemberConcurrency: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_MEMBER_CONCURRENCY'],
      'FEEDGEN_SPACE_SYNC_MEMBER_CONCURRENCY',
      DEFAULT_SPACE_SYNC_MEMBER_CONCURRENCY,
    ),
    spaceSyncMaxRecordBytes: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_MAX_RECORD_BYTES'],
      'FEEDGEN_SPACE_SYNC_MAX_RECORD_BYTES',
      DEFAULT_SPACE_SYNC_MAX_RECORD_BYTES,
    ),
    spaceSyncMaxRecordsPerMember: parsePositiveInt(
      env['FEEDGEN_SPACE_SYNC_MAX_RECORDS_PER_MEMBER'],
      'FEEDGEN_SPACE_SYNC_MAX_RECORDS_PER_MEMBER',
      DEFAULT_SPACE_SYNC_MAX_RECORDS_PER_MEMBER,
    ),
    spaceSyncAllowHttpOrigins: parseAllowHttpOrigins(
      env['FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS'],
    ),
  }
}

/** Treat an empty env var the same as an unset one. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value
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

function parseSpaceSyncPageLimit(value: string | undefined): number {
  return parseBoundedPositiveInt(
    value,
    'FEEDGEN_SPACE_SYNC_PAGE_LIMIT',
    DEFAULT_SPACE_SYNC_PAGE_LIMIT,
    MAX_SPACE_SYNC_PAGE_LIMIT,
  )
}

function parseBoundedPositiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = parsePositiveInt(value, name, fallback)
  if (parsed > maximum) {
    throw new Error(`Invalid ${name}: ${parsed} (maximum ${maximum})`)
  }
  return parsed
}

function parseBoolean(
  value: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  if (value === undefined || value === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`Invalid ${name}: ${value} (expected 'true' or 'false')`)
}

/**
 * Parses `FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS` into the exact set of
 * `http://` origins a member host is allowed to use. `https://` origins are
 * always allowed and never belong in this list, so an entry that isn't a
 * bare `http://` origin fails fast at load rather than being ignored.
 */
function parseAllowHttpOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value === '') {
    return DEFAULT_SPACE_SYNC_ALLOW_HTTP_ORIGINS
  }
  return new Set(parseCommaList(value).map(parseHttpOrigin))
}

function parseHttpOrigin(entry: string): string {
  const name = 'FEEDGEN_SPACE_SYNC_ALLOW_HTTP_HOSTS'
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    throw new Error(`Invalid ${name} entry "${entry}": not a valid URL`)
  }
  if (url.protocol !== 'http:') {
    throw new Error(
      `Invalid ${name} entry "${entry}": expected an http:// origin (https is always allowed)`,
    )
  }
  const isBareOrigin =
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  if (!isBareOrigin) {
    throw new Error(
      `Invalid ${name} entry "${entry}": expected a bare origin with no path, query, or userinfo`,
    )
  }
  return url.origin
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
