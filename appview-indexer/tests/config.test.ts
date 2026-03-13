import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../src/config.ts'

const REQUIRED_KEYS = [
  'BSKY_DB_POSTGRES_URL',
  'BSKY_REPO_PROVIDER',
  'STRATOS_SERVICE_URL',
  'STRATOS_SYNC_TOKEN',
]

const OPTIONAL_KEYS = [
  'BSKY_DB_POSTGRES_SCHEMA',
  'BSKY_DB_POOL_SIZE',
  'BSKY_DID_PLC_URL',
  'HEALTH_PORT',
]

describe('Config', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save current values for all keys we touch
    for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
      savedEnv[key] = process.env[key]
    }

    // Set all required env vars to valid defaults
    process.env.BSKY_DB_POSTGRES_URL =
      'postgresql://spike:bebop@localhost:5432/bsky'
    process.env.BSKY_REPO_PROVIDER = 'wss://bebop.example.com'
    process.env.STRATOS_SERVICE_URL = 'https://stratos.example.com'
    process.env.STRATOS_SYNC_TOKEN = 'bebop-sync-token-secret'

    // Clear optional keys
    for (const key of OPTIONAL_KEYS) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore saved env values
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  describe('loadConfig', () => {
    it('should load all required environment variables', () => {
      const config = loadConfig()

      expect(config.db.postgresUrl).toBe(
        'postgresql://spike:bebop@localhost:5432/bsky',
      )
      expect(config.pds.repoProvider).toBe('wss://bebop.example.com')
      expect(config.stratos.serviceUrl).toBe('https://stratos.example.com')
      expect(config.stratos.syncToken).toBe('bebop-sync-token-secret')
    })

    it('should apply default values for optional variables', () => {
      const config = loadConfig()

      expect(config.db.schema).toBe('bsky')
      expect(config.db.poolSize).toBe(10)
      expect(config.identity.plcUrl).toBe('https://plc.directory')
      expect(config.health.port).toBe(3002)
    })

    it('should override defaults when optional variables are set', () => {
      process.env.BSKY_DB_POSTGRES_SCHEMA = 'nerv'
      process.env.BSKY_DB_POOL_SIZE = '50'
      process.env.BSKY_DID_PLC_URL = 'https://plc.nerv.example.com'
      process.env.HEALTH_PORT = '9090'

      const config = loadConfig()

      expect(config.db.schema).toBe('nerv')
      expect(config.db.poolSize).toBe(50)
      expect(config.identity.plcUrl).toBe('https://plc.nerv.example.com')
      expect(config.health.port).toBe(9090)
    })

    it('should throw when BSKY_DB_POSTGRES_URL is missing', () => {
      delete process.env.BSKY_DB_POSTGRES_URL

      expect(() => loadConfig()).toThrow(
        'required environment variable BSKY_DB_POSTGRES_URL is not set',
      )
    })

    it('should throw when BSKY_REPO_PROVIDER is missing', () => {
      delete process.env.BSKY_REPO_PROVIDER

      expect(() => loadConfig()).toThrow(
        'required environment variable BSKY_REPO_PROVIDER is not set',
      )
    })

    it('should throw when STRATOS_SERVICE_URL is missing', () => {
      delete process.env.STRATOS_SERVICE_URL

      expect(() => loadConfig()).toThrow(
        'required environment variable STRATOS_SERVICE_URL is not set',
      )
    })

    it('should throw when STRATOS_SYNC_TOKEN is missing', () => {
      delete process.env.STRATOS_SYNC_TOKEN

      expect(() => loadConfig()).toThrow(
        'required environment variable STRATOS_SYNC_TOKEN is not set',
      )
    })

    it('should throw when BSKY_DB_POOL_SIZE is not an integer', () => {
      process.env.BSKY_DB_POOL_SIZE = 'not-a-number'

      expect(() => loadConfig()).toThrow(
        'environment variable BSKY_DB_POOL_SIZE must be an integer',
      )
    })

    it('should throw when HEALTH_PORT is not an integer', () => {
      process.env.HEALTH_PORT = 'abc'

      expect(() => loadConfig()).toThrow(
        'environment variable HEALTH_PORT must be an integer',
      )
    })
  })
})
