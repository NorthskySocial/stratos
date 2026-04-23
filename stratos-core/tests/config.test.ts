import { describe, expect, it } from 'vitest'
import {
  dbConfigSchema,
  loggingConfigSchema,
  parseCommaList,
} from '../src/config/index.js'

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
  })

  describe('loggingConfigSchema', () => {
    it('should default to info', () => {
      const result = loggingConfigSchema.parse({})
      expect(result.LOG_LEVEL).toBe('info')
    })
  })

  describe('parseCommaList', () => {
    it('should parse comma separated strings', () => {
      expect(parseCommaList('a, b, c')).toEqual(['a', 'b', 'c'])
      expect(parseCommaList('a,,c ')).toEqual(['a', 'c'])
      expect(parseCommaList('')).toEqual([])
    })
  })
})
