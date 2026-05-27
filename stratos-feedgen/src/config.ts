/**
 * Configuration for the Stratos feed generator.
 *
 */
export interface FeedgenConfig {
  /** DID of this feed generator service (e.g. `did:web:feedgen.example.com`). */
  feedgenServiceDid: string
  /** Private signing key for this feed generator's service identity. */
  feedgenSigningKey: string
  /** Base URL of the upstream Stratos service. */
  stratosServiceUrl: string
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
}

export type StorageBackend = 'sqlite' | 'postgres'

export const DEFAULT_STORAGE_BACKEND: StorageBackend = 'sqlite'

/** Lxms accepted on inbound service-auth JWTs. WP9 will append `getBlob`. */
export const DEFAULT_ALLOWED_LXMS: readonly string[] = [
  'zone.stratos.feedgen.getFeed',
]

export const DEFAULT_PLC_URL = 'https://plc.directory'

export interface FeedgenEnv {
  [key: string]: string | undefined
}

export function loadFeedgenConfig(
  env: FeedgenEnv = process.env as FeedgenEnv,
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

  return {
    feedgenServiceDid: requireEnv(env, 'FEEDGEN_SERVICE_DID'),
    feedgenSigningKey: requireEnv(env, 'FEEDGEN_SIGNING_KEY'),
    stratosServiceUrl: trimTrailingSlash(
      requireEnv(env, 'STRATOS_SERVICE_URL'),
    ),
    stratosServiceDid: requireEnv(env, 'STRATOS_SERVICE_DID'),
    feedgenPlcUrl: trimTrailingSlash(env['FEEDGEN_PLC_URL'] ?? DEFAULT_PLC_URL),
    feedgenAllowedLxms: DEFAULT_ALLOWED_LXMS,
    storageBackend,
    sqlitePath,
    postgresUrl,
    postgresSchema,
  }
}

function parseStorageBackend(value: string | undefined): StorageBackend {
  if (value === undefined || value === '') return DEFAULT_STORAGE_BACKEND
  if (value === 'sqlite' || value === 'postgres') return value
  throw new Error(
    `Invalid FEEDGEN_STORAGE_BACKEND: ${value} (expected 'sqlite' or 'postgres')`,
  )
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
