export interface IndexerConfig {
  db: DbConfig
  pds: PdsConfig
  stratos: StratosConfig
  identity: IdentityConfig
  health: HealthConfig
}

export interface DbConfig {
  postgresUrl: string
  schema: string
  poolSize: number
}

export interface PdsConfig {
  repoProvider: string
}

export interface StratosConfig {
  serviceUrl: string
  syncToken: string
}

export interface IdentityConfig {
  plcUrl: string
}

export interface HealthConfig {
  port: number
}

export function loadConfig(): IndexerConfig {
  return {
    db: {
      postgresUrl: requireEnv('BSKY_DB_POSTGRES_URL'),
      schema: env('BSKY_DB_POSTGRES_SCHEMA', 'bsky'),
      poolSize: envInt('BSKY_DB_POOL_SIZE', 10),
    },
    pds: {
      repoProvider: requireEnv('BSKY_REPO_PROVIDER'),
    },
    stratos: {
      serviceUrl: requireEnv('STRATOS_SERVICE_URL'),
      syncToken: requireEnv('STRATOS_SYNC_TOKEN'),
    },
    identity: {
      plcUrl: env('BSKY_DID_PLC_URL', 'https://plc.directory'),
    },
    health: {
      port: envInt('HEALTH_PORT', 3002),
    },
  }
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`required environment variable ${key} is not set`)
  }
  return value
}

function env(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue
}

function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key]
  if (!raw) return defaultValue
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed)) {
    throw new Error(
      `environment variable ${key} must be an integer, got: ${raw}`,
    )
  }
  return parsed
}
