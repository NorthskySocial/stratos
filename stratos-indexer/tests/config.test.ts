import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('loads config from environment variables', () => {
    process.env.BSKY_DB_POSTGRES_URL =
      'postgresql://shinji:eva01@localhost/nerv'
    process.env.BSKY_REPO_PROVIDER = 'wss://bsky.network'
    process.env.STRATOS_SERVICE_URL = 'https://stratos.tokyo-3.jp'
    process.env.STRATOS_SYNC_TOKEN = 'secret-token-from-seele'

    const config = loadConfig()

    expect(config.db.postgresUrl).toBe(
      'postgresql://shinji:eva01@localhost/nerv',
    )
    expect(config.db.schema).toBe('bsky')
    expect(config.db.poolSize).toBe(20)
    expect(config.pds.repoProvider).toBe('wss://bsky.network')
    expect(config.pds.enrolledOnly).toBe(false)
    expect(config.stratos.serviceUrl).toBe('https://stratos.tokyo-3.jp')
    expect(config.stratos.syncToken).toBe('secret-token-from-seele')
    expect(config.identity.plcUrl).toBe('https://plc.directory')
    expect(config.health.port).toBe(3002)
    expect(config.worker.concurrency).toBe(4)
    expect(config.worker.maxQueueSize).toBe(100)
    expect(config.worker.cursorFlushIntervalMs).toBe(5000)
    expect(config.worker.actorSyncConcurrency).toBe(8)
    expect(config.worker.actorSyncQueuePerActor).toBe(10)
    expect(config.worker.backgroundQueueConcurrency).toBe(10)
  })

  it('uses custom values from environment variables', () => {
    process.env.BSKY_DB_POSTGRES_URL = 'postgresql://misato@localhost/nerv'
    process.env.BSKY_DB_POSTGRES_SCHEMA = 'custom_schema'
    process.env.BSKY_DB_POOL_SIZE = '25'
    process.env.BSKY_REPO_PROVIDER = 'wss://relay.example.com'
    process.env.STRATOS_SERVICE_URL = 'https://stratos.example.com'
    process.env.STRATOS_SYNC_TOKEN = 'token'
    process.env.BSKY_DID_PLC_URL = 'https://plc.custom.com'
    process.env.HEALTH_PORT = '9090'
    process.env.WORKER_CONCURRENCY = '8'
    process.env.WORKER_MAX_QUEUE_SIZE = '500'
    process.env.CURSOR_FLUSH_INTERVAL_MS = '10000'
    process.env.BACKFILL_ENROLLED_ONLY = 'true'

    const config = loadConfig()

    expect(config.db.schema).toBe('custom_schema')
    expect(config.db.poolSize).toBe(25)
    expect(config.pds.enrolledOnly).toBe(true)
    expect(config.identity.plcUrl).toBe('https://plc.custom.com')
    expect(config.health.port).toBe(9090)
    expect(config.worker.concurrency).toBe(8)
    expect(config.worker.maxQueueSize).toBe(500)
    expect(config.worker.cursorFlushIntervalMs).toBe(10000)
  })

  it('throws on missing required variables', () => {
    delete process.env.BSKY_DB_POSTGRES_URL
    delete process.env.BSKY_REPO_PROVIDER
    delete process.env.STRATOS_SERVICE_URL
    delete process.env.STRATOS_SYNC_TOKEN

    expect(() => loadConfig()).toThrow('required environment variable')
  })

  it('throws on non-integer numeric values', () => {
    process.env.BSKY_DB_POSTGRES_URL = 'postgresql://localhost/test'
    process.env.BSKY_REPO_PROVIDER = 'wss://bsky.network'
    process.env.STRATOS_SERVICE_URL = 'https://stratos.example.com'
    process.env.STRATOS_SYNC_TOKEN = 'token'
    process.env.HEALTH_PORT = 'not-a-number'

    expect(() => loadConfig()).toThrow('must be an integer')
  })
})
