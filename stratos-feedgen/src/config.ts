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
}

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
  return {
    feedgenServiceDid: requireEnv(env, 'FEEDGEN_SERVICE_DID'),
    feedgenSigningKey: requireEnv(env, 'FEEDGEN_SIGNING_KEY'),
    stratosServiceUrl: trimTrailingSlash(
      requireEnv(env, 'STRATOS_SERVICE_URL'),
    ),
    stratosServiceDid: requireEnv(env, 'STRATOS_SERVICE_DID'),
    feedgenPlcUrl: trimTrailingSlash(env['FEEDGEN_PLC_URL'] ?? DEFAULT_PLC_URL),
    feedgenAllowedLxms: DEFAULT_ALLOWED_LXMS,
  }
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
