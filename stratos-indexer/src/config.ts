export interface IndexerConfig {
  db: DbConfig
  pds: PdsConfig
  stratos: StratosConfig
  identity: IdentityConfig
  health: HealthConfig
  worker: WorkerConfig
}

export interface DbConfig {
  postgresUrl: string
  schema: string
  poolSize: number
}

export interface PdsConfig {
  repoProvider: string
  enrolledOnly: boolean
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

export interface WorkerConfig {
  concurrency: number
  maxQueueSize: number
  cursorFlushIntervalMs: number
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
      enrolledOnly: envBool('BACKFILL_ENROLLED_ONLY', false),
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
    worker: {
      concurrency: envInt('WORKER_CONCURRENCY', 4),
      maxQueueSize: envInt('WORKER_MAX_QUEUE_SIZE', 1000),
      cursorFlushIntervalMs: envInt('CURSOR_FLUSH_INTERVAL_MS', 5000),
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

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key]
  if (!raw) return defaultValue
  return raw === '1' || raw.toLowerCase() === 'true'
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
