import { describe, expect, it } from 'vitest'
import {
  commaListSchema,
  dbConfigSchema,
  loggingConfigSchema,
  parseCommaList,
  redisConfigSchema,
} from '../src'

describe('Configuration Schemas', () => {
  describe('dbConfigSchema', () => {
    it('should have default values for sqlite', () => {
      const result = dbConfigSchema.parse({})
      expect(result.STORAGE_BACKEND).toBe('sqlite')
      expect(result.STRATOS_DATA_DIR).toBe('./data')
    })

    it('should validate postgres config', () => {
      const config = {
        STORAGE_BACKEND: 'postgres',
        STRATOS_POSTGRES_URL: 'postgres://localhost:5432/db',
      }
      const result = dbConfigSchema.parse(config)
      expect(result.STORAGE_BACKEND).toBe('postgres')
      expect(result.STRATOS_POSTGRES_URL).toBe('postgres://localhost:5432/db')
    })

    it('should validate postgres connection details', () => {
      const config = {
        STORAGE_BACKEND: 'postgres',
        STRATOS_PG_HOST: 'localhost',
        STRATOS_PG_PORT: '5432',
        STRATOS_PG_USERNAME: 'unit-01',
        STRATOS_PG_PASSWORD: 'nerv',
        STRATOS_PG_DBNAME: 'stratos',
        STRATOS_PG_SSLMODE: 'require',
        STRATOS_PG_ACTOR_POOL_SIZE: '10',
        STRATOS_PG_ADMIN_POOL_SIZE: '5',
      }
      const result = dbConfigSchema.parse(config)
      expect(result.STRATOS_PG_HOST).toBe('localhost')
      expect(result.STRATOS_PG_PORT).toBe(5432)
      expect(result.STRATOS_PG_USERNAME).toBe('unit-01')
      expect(result.STRATOS_PG_PASSWORD).toBe('nerv')
      expect(result.STRATOS_PG_DBNAME).toBe('stratos')
      expect(result.STRATOS_PG_SSLMODE).toBe('require')
      expect(result.STRATOS_PG_ACTOR_POOL_SIZE).toBe(10)
      expect(result.STRATOS_PG_ADMIN_POOL_SIZE).toBe(5)
    })
  })

  describe('loggingConfigSchema', () => {
    it('should default to info', () => {
      const result = loggingConfigSchema.parse({})
      expect(result.LOG_LEVEL).toBe('info')
    })

    it('should validate all log levels', () => {
      const levels = [
        'fatal',
        'error',
        'warn',
        'info',
        'debug',
        'trace',
        'silent',
      ]
      for (const level of levels) {
        expect(loggingConfigSchema.parse({ LOG_LEVEL: level }).LOG_LEVEL).toBe(
          level,
        )
      }
    })

    it('should fail on invalid log level', () => {
      expect(() =>
        loggingConfigSchema.parse({ LOG_LEVEL: 'verbose' }),
      ).toThrow()
    })
  })

  describe('redisConfigSchema', () => {
    it('should validate redis config', () => {
      const config = {
        REDIS_HOST: 'localhost',
        REDIS_PORT: '6379',
        REDIS_PASSWORD: 'password',
      }
      const result = redisConfigSchema.parse(config)
      expect(result.REDIS_HOST).toBe('localhost')
      expect(result.REDIS_PORT).toBe(6379)
      expect(result.REDIS_PASSWORD).toBe('password')
    })
  })

  describe('parseCommaList', () => {
    it('should parse comma separated strings', () => {
      expect(parseCommaList('a, b, c')).toEqual(['a', 'b', 'c'])
      expect(parseCommaList('a,,c ')).toEqual(['a', 'c'])
      expect(parseCommaList('')).toEqual([])
    })

    it('should handle Rei, Shinji, Asuka list', () => {
      expect(parseCommaList('Rei, Shinji, Asuka')).toEqual([
        'Rei',
        'Shinji',
        'Asuka',
      ])
    })
  })

  describe('commaListSchema', () => {
    it('should transform string to list', () => {
      expect(commaListSchema.parse('one,two,three')).toEqual([
        'one',
        'two',
        'three',
      ])
    })

    it('should handle empty string as empty list', () => {
      expect(commaListSchema.parse('')).toEqual([])
    })
  })
})
