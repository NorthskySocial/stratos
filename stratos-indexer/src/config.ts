import { z } from 'zod'
import { loggingConfigSchema } from '@northskysocial/stratos-core'

/**
 * Environment variable schema for stratos indexer
 */
const envSchema = z
  .object({
    // Database
    BSKY_DB_POSTGRES_URL: z.string().min(1),
    BSKY_DB_POSTGRES_SCHEMA: z.string().default('bsky'),
    BSKY_DB_POOL_SIZE: z.coerce.number().int().positive().default(20),

    // PDS
    BSKY_REPO_PROVIDER: z.string().min(1),
    BACKFILL_ENROLLED_ONLY: z.coerce
      .string()
      .default('false')
      .transform((v) => v === '1' || v.toLowerCase() === 'true'),

    // Stratos
    STRATOS_SERVICE_URL: z.string().url(),
    STRATOS_SYNC_TOKEN: z.string().min(1),

    // Identity
    BSKY_DID_PLC_URL: z.string().url().default('https://plc.directory'),

    // Health
    HEALTH_PORT: z.coerce.number().int().positive().default(3002),

    // Worker & Sync
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    WORKER_MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(100),
    CURSOR_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    ACTOR_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(8),
    ACTOR_SYNC_QUEUE_PER_ACTOR: z.coerce.number().int().positive().default(10),
    ACTOR_SYNC_GLOBAL_MAX_PENDING: z.coerce
      .number()
      .int()
      .positive()
      .default(500),
    ACTOR_SYNC_DRAIN_DELAY_MS: z.coerce.number().int().nonnegative().default(5),
    ACTOR_SYNC_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),
    ACTOR_SYNC_CONNECT_DELAY_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(200),
    ACTOR_SYNC_IDLE_EVICTION_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60000),
    ACTOR_SYNC_RECONNECT_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1000),
    ACTOR_SYNC_RECONNECT_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60000),
    ACTOR_SYNC_RECONNECT_JITTER_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(1000),
    ACTOR_SYNC_RECONNECT_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .positive()
      .default(20),
    BACKGROUND_QUEUE_CONCURRENCY: z.coerce
      .number()
      .int()
      .positive()
      .default(10),
    BACKGROUND_QUEUE_MAX_SIZE: z.coerce.number().int().positive().default(1000),
  })
  .merge(loggingConfigSchema)

export type Env = z.infer<typeof envSchema>

/**
 * Parses environment variables and validates them against the schema.
 */
export function parseEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ')
    throw new Error(`Invalid environment variables: ${errors}`)
  }
  return result.data
}

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
  /** Concurrent workers for PDS firehose message processing */
  concurrency: number
  /** Max firehose message queue size before backpressure kicks in */
  maxQueueSize: number
  /** Interval to flush PDS and Stratos cursors to database */
  cursorFlushIntervalMs: number
  /** Concurrent actors to synchronize from Stratos services simultaneously */
  actorSyncConcurrency: number
  /** Max pending records per actor before pausing subscription */
  actorSyncQueuePerActor: number
  /** Total max pending records across all actors to prevent memory exhaustion */
  actorSyncGlobalMaxPending: number
  /** Delay between processing records for an actor to prevent CPU spikes */
  actorSyncDrainDelayMs: number
  /** Max simultaneous WebSocket connections to Stratos services */
  actorSyncMaxConnections: number
  /** Delay between opening new actor sync connections to avoid thundering herd */
  actorSyncConnectDelayMs: number
  /** Time after which an idle actor sync connection is closed */
  actorSyncIdleEvictionMs: number
  /** Initial delay for exponential backoff on actor sync reconnection */
  actorSyncReconnectBaseDelayMs: number
  /** Max delay for exponential backoff on actor sync reconnection */
  actorSyncReconnectMaxDelayMs: number
  /** Jitter added to reconnection delays to prevent synchronized reconnects */
  actorSyncReconnectJitterMs: number
  /** Max attempts to reconnect an actor before giving up */
  actorSyncReconnectMaxAttempts: number
  /** Concurrency for the @atproto/bsky background indexer queue */
  backgroundQueueConcurrency: number
  /** Max size of the background indexer queue */
  backgroundQueueMaxSize: number
}

export function loadConfig(): IndexerConfig {
  const env = parseEnv()
  return {
    db: {
      postgresUrl: env.BSKY_DB_POSTGRES_URL,
      schema: env.BSKY_DB_POSTGRES_SCHEMA,
      poolSize: env.BSKY_DB_POOL_SIZE,
    },
    pds: {
      repoProvider: env.BSKY_REPO_PROVIDER,
      enrolledOnly: env.BACKFILL_ENROLLED_ONLY,
    },
    stratos: {
      serviceUrl: env.STRATOS_SERVICE_URL,
      syncToken: env.STRATOS_SYNC_TOKEN,
    },
    identity: {
      plcUrl: env.BSKY_DID_PLC_URL,
    },
    health: {
      port: env.HEALTH_PORT,
    },
    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      maxQueueSize: env.WORKER_MAX_QUEUE_SIZE,
      cursorFlushIntervalMs: env.CURSOR_FLUSH_INTERVAL_MS,
      actorSyncConcurrency: env.ACTOR_SYNC_CONCURRENCY,
      actorSyncQueuePerActor: env.ACTOR_SYNC_QUEUE_PER_ACTOR,
      actorSyncGlobalMaxPending: env.ACTOR_SYNC_GLOBAL_MAX_PENDING,
      actorSyncDrainDelayMs: env.ACTOR_SYNC_DRAIN_DELAY_MS,
      actorSyncMaxConnections: env.ACTOR_SYNC_MAX_CONNECTIONS,
      actorSyncConnectDelayMs: env.ACTOR_SYNC_CONNECT_DELAY_MS,
      actorSyncIdleEvictionMs: env.ACTOR_SYNC_IDLE_EVICTION_MS,
      actorSyncReconnectBaseDelayMs: env.ACTOR_SYNC_RECONNECT_BASE_DELAY_MS,
      actorSyncReconnectMaxDelayMs: env.ACTOR_SYNC_RECONNECT_MAX_DELAY_MS,
      actorSyncReconnectJitterMs: env.ACTOR_SYNC_RECONNECT_JITTER_MS,
      actorSyncReconnectMaxAttempts: env.ACTOR_SYNC_RECONNECT_MAX_ATTEMPTS,
      backgroundQueueConcurrency: env.BACKGROUND_QUEUE_CONCURRENCY,
      backgroundQueueMaxSize: env.BACKGROUND_QUEUE_MAX_SIZE,
    },
  }
}
