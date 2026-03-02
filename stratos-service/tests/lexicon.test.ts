/**
 * Tests for Stratos lexicon loading and XrpcServer integration
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { schemas as atprotoSchemas } from '@atproto/api'
import type { LexiconDoc } from '@atproto/lexicon'
import { loadStratosLexicons } from '../src/context.js'

// Expected Stratos lexicon IDs
const EXPECTED_STRATOS_LEXICONS = [
  'zonestratos.actor.enrollment',
  'zonestratos.boundary.defs',
  'zonestratos.defs',
  'zonestratos.enrollment.status',
  'zonestratos.feed.post',
  'zonestratos.repo.hydrateRecord',
  'zonestratos.repo.hydrateRecords',
  'zonestratos.repo.importRepo',
  'zonestratos.sync.getRepo',
  'zonestratos.sync.subscribeRecords',
]

describe('Stratos Lexicons', () => {
  describe('loadStratosLexicons', () => {
    it('should load all expected lexicon files', () => {
      const lexicons = loadStratosLexicons()
      const ids = lexicons.map((lex) => lex.id).sort()

      expect(ids).toEqual(EXPECTED_STRATOS_LEXICONS.sort())
    })

    it('should load valid lexicon documents', () => {
      const lexicons = loadStratosLexicons()

      for (const lexicon of lexicons) {
        expect(lexicon.lexicon).toBe(1)
        expect(typeof lexicon.id).toBe('string')
        expect(lexicon.id).toMatch(/^app\.northsky\.stratos\./)
        expect(lexicon.defs).toBeDefined()
        expect(typeof lexicon.defs).toBe('object')
      }
    })

    it('should return lexicon array with correct count', () => {
      const lexicons = loadStratosLexicons()
      expect(lexicons).toHaveLength(EXPECTED_STRATOS_LEXICONS.length)
    })
  })

  describe('Lexicon structure validation', () => {
    let lexicons: LexiconDoc[]

    beforeAll(() => {
      lexicons = loadStratosLexicons()
    })

    it('zonestratos.enrollment.status should be a query', () => {
      const lex = lexicons.find(
        (l) => l.id === 'zonestratos.enrollment.status',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('query')
    })

    it('zonestratos.repo.hydrateRecord should be a query', () => {
      const lex = lexicons.find(
        (l) => l.id === 'zonestratos.repo.hydrateRecord',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('query')
    })

    it('zonestratos.repo.hydrateRecords should be a procedure', () => {
      const lex = lexicons.find(
        (l) => l.id === 'zonestratos.repo.hydrateRecords',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('procedure')
    })

    it('zonestratos.sync.subscribeRecords should be a subscription', () => {
      const lex = lexicons.find(
        (l) => l.id === 'zonestratos.sync.subscribeRecords',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('subscription')
    })

    it('zonestratos.feed.post should be a record', () => {
      const lex = lexicons.find(
        (l) => l.id === 'zonestratos.feed.post',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('record')
    })

    it('zonestratos.actor.enrollment should be a record', () => {
      const lex = lexicons.find(
        (l) => l.id === 'zonestratos.actor.enrollment',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('record')
    })
  })

  describe('XrpcServer integration', () => {
    it('should create XrpcServer with ATProto schemas', () => {
      expect(() => {
        new XrpcServer(atprotoSchemas)
      }).not.toThrow()
    })

    it('should create XrpcServer with combined lexicons', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]

      expect(() => {
        new XrpcServer(allLexicons)
      }).not.toThrow()
    })

    it('should recognize ATProto methods after loading lexicons', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]
      const server = new XrpcServer(allLexicons)

      // Access the internal lexicon store via the lex property
      const lexStore = (server as any).lex

      // Verify ATProto methods are available
      expect(lexStore.getDef('com.atproto.repo.createRecord')).toBeDefined()
      expect(lexStore.getDef('com.atproto.repo.deleteRecord')).toBeDefined()
      expect(lexStore.getDef('com.atproto.repo.getRecord')).toBeDefined()
      expect(lexStore.getDef('com.atproto.repo.listRecords')).toBeDefined()
    })

    it('should recognize Stratos methods after loading lexicons', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]
      const server = new XrpcServer(allLexicons)

      // Access the internal lexicon store
      const lexStore = (server as any).lex

      // Verify Stratos methods are available
      expect(
        lexStore.getDef('zonestratos.enrollment.status'),
      ).toBeDefined()
      expect(
        lexStore.getDef('zonestratos.repo.hydrateRecord'),
      ).toBeDefined()
      expect(
        lexStore.getDef('zonestratos.repo.hydrateRecords'),
      ).toBeDefined()
    })

    it('should allow registering handlers for Stratos methods', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]
      const server = new XrpcServer(allLexicons)

      // Should not throw when registering handlers for Stratos methods
      expect(() => {
        server.method('zonestratos.enrollment.status', {
          handler: async () => ({
            encoding: 'application/json',
            body: { did: 'did:test:123', enrolled: false },
          }),
        })
      }).not.toThrow()

      expect(() => {
        server.method('zonestratos.repo.hydrateRecord', {
          handler: async () => ({
            encoding: 'application/json',
            body: {
              uri: 'at://test/zonestratos.feed.post/123',
              cid: 'abc',
              value: {},
            },
          }),
        })
      }).not.toThrow()
    })

    it('should allow registering procedure handlers', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]
      const server = new XrpcServer(allLexicons)

      expect(() => {
        server.method('zonestratos.repo.hydrateRecords', {
          handler: async () => ({
            encoding: 'application/json',
            body: { records: [], notFound: [], blocked: [] },
          }),
        })
      }).not.toThrow()
    })

    it('should allow registering ATProto method handlers', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]
      const server = new XrpcServer(allLexicons)

      expect(() => {
        server.method('com.atproto.repo.createRecord', {
          handler: async () => ({
            encoding: 'application/json',
            body: { uri: 'at://test/app.bsky.feed.post/123', cid: 'abc' },
          }),
        })
      }).not.toThrow()
    })
  })
})
