import { describe, it, expect } from 'vitest'
import {
  assertStratosValidation,
  assertBskyNoCrossNamespaceEmbed,
  isStratosUri,
  isBskyUri,
  isStratosCollection,
  extractBoundaryDomains,
} from '../src/validation/stratos-validation.js'
import { StratosConfig, StratosValidationError } from '../src/types.js'

describe('stratos-validation', () => {
  const validConfig: StratosConfig = {
    allowedDomains: ['example.com', 'corp.example.com'],
    retentionDays: 90,
  }

  describe('assertStratosValidation', () => {
    it('should pass for non-stratos collections', () => {
      const record = { text: 'hello' }

      expect(() => {
        assertStratosValidation(record, 'app.bsky.feed.post', validConfig)
      }).not.toThrow()
    })

    it('should throw when stratos is not enabled', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', undefined)
      }).toThrow(StratosValidationError)
    })

    it('should throw when no allowed domains are configured', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
      }
      const emptyConfig: StratosConfig = {
        allowedDomains: [],
        retentionDays: 90,
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', emptyConfig)
      }).toThrow(StratosValidationError)
    })

    it('should pass for valid stratos post with allowed domain', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).not.toThrow()
    })

    it('should pass for stratos post with multiple allowed domains', () => {
      const record = {
        text: 'test',
        boundary: {
          values: [{ value: 'example.com' }, { value: 'corp.example.com' }],
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).not.toThrow()
    })

    it('should throw for stratos post with missing boundary', () => {
      const record = {
        text: 'test',
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).toThrow('must have a boundary')
    })

    it('should throw for stratos post with empty boundary values', () => {
      const record = {
        text: 'test',
        boundary: { values: [] },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).toThrow('must have a boundary')
    })

    it('should throw for stratos post with disallowed domain', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'other.com' }] },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).toThrow('not allowed')
    })

    it('should throw for stratos post replying to bsky post', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/123',
            cid: 'bafyabc',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).toThrow('cannot reply to a non-stratos record')
    })

    it('should pass for stratos post replying to stratos post', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/app.stratos.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/app.stratos.feed.post/456',
            cid: 'bafydef',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).not.toThrow()
    })

    it('should throw for stratos post embedding bsky record', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
        embed: {
          $type: 'app.bsky.embed.record',
          record: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/123',
            cid: 'bafyabc',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).toThrow('cannot embed bsky content')
    })

    it('should pass for stratos post embedding stratos record', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'example.com' }] },
        embed: {
          $type: 'app.bsky.embed.record',
          record: {
            uri: 'at://did:plc:abc/app.stratos.feed.post/123',
            cid: 'bafyabc',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        assertStratosValidation(record, 'app.stratos.feed.post', validConfig)
      }).not.toThrow()
    })
  })

  describe('assertBskyNoCrossNamespaceEmbed', () => {
    it('should pass for non-bsky collections', () => {
      const record = {
        embed: {
          record: { uri: 'at://did:plc:abc/app.stratos.feed.post/123' },
        },
      }

      expect(() => {
        assertBskyNoCrossNamespaceEmbed(record, 'app.stratos.feed.post')
      }).not.toThrow()
    })

    it('should pass for bsky post without embed', () => {
      const record = { text: 'hello' }

      expect(() => {
        assertBskyNoCrossNamespaceEmbed(record, 'app.bsky.feed.post')
      }).not.toThrow()
    })

    it('should pass for bsky post embedding bsky record', () => {
      const record = {
        text: 'test',
        embed: {
          record: { uri: 'at://did:plc:abc/app.bsky.feed.post/123' },
        },
      }

      expect(() => {
        assertBskyNoCrossNamespaceEmbed(record, 'app.bsky.feed.post')
      }).not.toThrow()
    })

    it('should throw for bsky post embedding stratos record', () => {
      const record = {
        text: 'test',
        embed: {
          record: { uri: 'at://did:plc:abc/app.stratos.feed.post/123' },
        },
      }

      expect(() => {
        assertBskyNoCrossNamespaceEmbed(record, 'app.bsky.feed.post')
      }).toThrow('cannot embed stratos content')
    })
  })

  describe('isStratosUri', () => {
    it('should return true for stratos URIs', () => {
      expect(isStratosUri('at://did:plc:abc/app.stratos.feed.post/123')).toBe(
        true,
      )
      expect(
        isStratosUri('at://did:plc:abc/app.stratos.actor.profile/self'),
      ).toBe(true)
    })

    it('should return false for non-stratos URIs', () => {
      expect(isStratosUri('at://did:plc:abc/app.bsky.feed.post/123')).toBe(
        false,
      )
      expect(isStratosUri('at://did:plc:abc/com.atproto.repo.record/123')).toBe(
        false,
      )
    })

    it('should return false for invalid URIs', () => {
      expect(isStratosUri('')).toBe(false)
      expect(isStratosUri('not-a-uri')).toBe(false)
      expect(isStratosUri('https://example.com')).toBe(false)
    })
  })

  describe('isBskyUri', () => {
    it('should return true for bsky URIs', () => {
      expect(isBskyUri('at://did:plc:abc/app.bsky.feed.post/123')).toBe(true)
      expect(isBskyUri('at://did:plc:abc/app.bsky.actor.profile/self')).toBe(
        true,
      )
    })

    it('should return false for non-bsky URIs', () => {
      expect(isBskyUri('at://did:plc:abc/app.stratos.feed.post/123')).toBe(
        false,
      )
      expect(isBskyUri('at://did:plc:abc/com.atproto.repo.record/123')).toBe(
        false,
      )
    })

    it('should return false for invalid URIs', () => {
      expect(isBskyUri('')).toBe(false)
      expect(isBskyUri('not-a-uri')).toBe(false)
    })
  })

  describe('isStratosCollection', () => {
    it('should return true for stratos collections', () => {
      expect(isStratosCollection('app.stratos.feed.post')).toBe(true)
      expect(isStratosCollection('app.stratos.actor.profile')).toBe(true)
      expect(isStratosCollection('app.stratos.some.future.collection')).toBe(
        true,
      )
    })

    it('should return false for non-stratos collections', () => {
      expect(isStratosCollection('app.bsky.feed.post')).toBe(false)
      expect(isStratosCollection('com.atproto.repo.record')).toBe(false)
      expect(isStratosCollection('')).toBe(false)
    })
  })

  describe('extractBoundaryDomains', () => {
    it('should extract domains from valid boundary', () => {
      const record = {
        boundary: {
          values: [{ value: 'example.com' }, { value: 'corp.example.com' }],
        },
      }

      expect(extractBoundaryDomains(record)).toEqual([
        'example.com',
        'corp.example.com',
      ])
    })

    it('should return empty array for missing boundary', () => {
      expect(extractBoundaryDomains({})).toEqual([])
      expect(extractBoundaryDomains({ text: 'hello' })).toEqual([])
    })

    it('should return empty array for empty boundary values', () => {
      expect(extractBoundaryDomains({ boundary: {} })).toEqual([])
      expect(extractBoundaryDomains({ boundary: { values: [] } })).toEqual([])
    })
  })
})
