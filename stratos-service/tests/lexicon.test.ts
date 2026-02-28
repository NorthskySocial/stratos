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
  'app.northsky.stratos.actor.enrollment',
  'app.northsky.stratos.boundary.defs',
  'app.northsky.stratos.defs',
  'app.northsky.stratos.enrollment.status',
  'app.northsky.stratos.feed.post',
  'app.northsky.stratos.repo.hydrateRecord',
  'app.northsky.stratos.repo.hydrateRecords',
  'app.northsky.stratos.repo.importRepo',
  'app.northsky.stratos.sync.getRepo',
  'app.northsky.stratos.sync.subscribeRecords',
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

    it('app.northsky.stratos.enrollment.status should be a query', () => {
      const lex = lexicons.find((l) => l.id === 'app.northsky.stratos.enrollment.status')
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('query')
    })

    it('app.northsky.stratos.repo.hydrateRecord should be a query', () => {
      const lex = lexicons.find(
        (l) => l.id === 'app.northsky.stratos.repo.hydrateRecord',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('query')
    })

    it('app.northsky.stratos.repo.hydrateRecords should be a procedure', () => {
      const lex = lexicons.find(
        (l) => l.id === 'app.northsky.stratos.repo.hydrateRecords',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('procedure')
    })

    it('app.northsky.stratos.sync.subscribeRecords should be a subscription', () => {
      const lex = lexicons.find(
        (l) => l.id === 'app.northsky.stratos.sync.subscribeRecords',
      )
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('subscription')
    })

    it('app.northsky.stratos.feed.post should be a record', () => {
      const lex = lexicons.find((l) => l.id === 'app.northsky.stratos.feed.post')
      expect(lex).toBeDefined()
      expect(lex?.defs?.main?.type).toBe('record')
    })

    it('app.northsky.stratos.actor.enrollment should be a record', () => {
      const lex = lexicons.find((l) => l.id === 'app.northsky.stratos.actor.enrollment')
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
      expect(lexStore.getDef('app.northsky.stratos.enrollment.status')).toBeDefined()
      expect(lexStore.getDef('app.northsky.stratos.repo.hydrateRecord')).toBeDefined()
      expect(lexStore.getDef('app.northsky.stratos.repo.hydrateRecords')).toBeDefined()
    })

    it('should allow registering handlers for Stratos methods', () => {
      const stratosLexicons = loadStratosLexicons()
      const allLexicons = [...atprotoSchemas, ...stratosLexicons]
      const server = new XrpcServer(allLexicons)

      // Should not throw when registering handlers for Stratos methods
      expect(() => {
        server.method('app.northsky.stratos.enrollment.status', {
          handler: async () => ({
            encoding: 'application/json',
            body: { did: 'did:test:123', enrolled: false },
          }),
        })
      }).not.toThrow()

      expect(() => {
        server.method('app.northsky.stratos.repo.hydrateRecord', {
          handler: async () => ({
            encoding: 'application/json',
            body: {
              uri: 'at://test/app.northsky.stratos.feed.post/123',
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
        server.method('app.northsky.stratos.repo.hydrateRecords', {
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
