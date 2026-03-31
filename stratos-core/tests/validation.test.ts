import { describe, expect, it } from 'vitest'
import {
  StratosConfig,
  StratosValidationError,
  StratosValidator,
} from '../src/index.js'

describe('stratos-validation', () => {
  const validConfig: StratosConfig = {
    serviceDid: 'did:web:nerv.tokyo.jp',
    allowedDomains: [
      'did:web:nerv.tokyo.jp/example-com',
      'did:web:nerv.tokyo.jp/bunnies-example-com',
    ],
    retentionDays: 90,
  }

  describe('StratosValidator', () => {
    const validator = new StratosValidator(validConfig)

    it('should pass for non-stratos collections', () => {
      const record = { text: 'hello' }

      expect(() => {
        validator.assertValid(record, 'app.bsky.feed.post')
      }).not.toThrow()
    })

    it('should throw when no allowed domains are configured', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
      }
      const emptyConfig: StratosConfig = {
        serviceDid: 'did:web:nerv.tokyo.jp',
        allowedDomains: [],
        retentionDays: 90,
      }
      const emptyValidator = new StratosValidator(emptyConfig)

      expect(() => {
        emptyValidator.assertValid(record, 'zone.stratos.feed.post')
      }).toThrow(StratosValidationError)
    })

    it('should pass for valid stratos post with allowed domain', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).not.toThrow()
    })

    it('should pass for stratos post with multiple allowed domains', () => {
      const record = {
        text: 'test',
        boundary: {
          values: [
            { value: 'did:web:nerv.tokyo.jp/example-com' },
            { value: 'did:web:nerv.tokyo.jp/bunnies-example-com' },
          ],
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).not.toThrow()
    })

    it('should throw for stratos post with missing boundary', () => {
      const record = {
        text: 'test',
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).toThrow('must have a boundary')
    })

    it('should throw for stratos post with empty boundary values', () => {
      const record = {
        text: 'test',
        boundary: { values: [] },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).toThrow('must have a boundary')
    })

    it('should throw for stratos post with disallowed domain', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/other-com' }] },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).toThrow('not allowed')
    })

    it('should throw for stratos post replying to bsky post', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
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
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).toThrow('cannot reply to a non-stratos record')
    })

    it('should pass for stratos post replying to stratos post', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/456',
            cid: 'bafydef',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).not.toThrow()
    })

    it('should pass when reply boundaries are a subset of parent boundaries', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/456',
            cid: 'bafydef',
          },
        },
        createdAt: new Date().toISOString(),
      }
      const parentBoundaries = [
        'did:web:nerv.tokyo.jp/example-com',
        'did:web:nerv.tokyo.jp/bunnies-example-com',
      ]

      expect(() => {
        validator.assertValid(
          record,
          'zone.stratos.feed.post',
          parentBoundaries,
        )
      }).not.toThrow()
    })

    it('should throw when reply has boundaries not in parent', () => {
      const record = {
        text: 'test',
        boundary: {
          values: [
            { value: 'did:web:nerv.tokyo.jp/example-com' },
            { value: 'did:web:nerv.tokyo.jp/bunnies-example-com' },
          ],
        },
        reply: {
          parent: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
            cid: 'bafyabc',
          },
          root: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/456',
            cid: 'bafydef',
          },
        },
        createdAt: new Date().toISOString(),
      }
      const parentBoundaries = ['did:web:nerv.tokyo.jp/example-com']

      expect(() => {
        validator.assertValid(
          record,
          'zone.stratos.feed.post',
          parentBoundaries,
        )
      }).toThrow(
        "Reply boundaries must be a subset of the parent's boundaries. Domains not in parent: did:web:nerv.tokyo.jp/bunnies-example-com",
      )
    })

    it('should throw for stratos post embedding bsky record', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
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
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).toThrow('cannot embed bsky content')
    })

    it('should pass for stratos post embedding stratos record', () => {
      const record = {
        text: 'test',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
        embed: {
          $type: 'app.bsky.embed.record',
          record: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
            cid: 'bafyabc',
          },
        },
        createdAt: new Date().toISOString(),
      }

      expect(() => {
        validator.assertValid(record, 'zone.stratos.feed.post')
      }).not.toThrow()
    })
  })

  describe('assertBskyNoCrossNamespaceEmbed', () => {
    it('should pass for non-bsky collections', () => {
      const record = {
        embed: {
          record: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
          },
        },
      }

      expect(() => {
        StratosValidator.assertBskyNoCrossNamespaceEmbed(
          record,
          'zone.stratos.feed.post',
        )
      }).not.toThrow()
    })

    it('should pass for bsky post without embed', () => {
      const record = { text: 'hello' }

      expect(() => {
        StratosValidator.assertBskyNoCrossNamespaceEmbed(
          record,
          'app.bsky.feed.post',
        )
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
        StratosValidator.assertBskyNoCrossNamespaceEmbed(
          record,
          'app.bsky.feed.post',
        )
      }).not.toThrow()
    })

    it('should throw for bsky post embedding stratos record', () => {
      const record = {
        text: 'test',
        embed: {
          record: {
            uri: 'at://did:plc:abc/zone.stratos.feed.post/123',
          },
        },
      }

      expect(() => {
        StratosValidator.assertBskyNoCrossNamespaceEmbed(
          record,
          'app.bsky.feed.post',
        )
      }).toThrow('cannot embed stratos content')
    })
  })

  describe('isStratosUri', () => {
    it('should return true for stratos URIs', () => {
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/zone.stratos.feed.post/123',
        ),
      ).toBe(true)
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/zone.stratos.actor.profile/self',
        ),
      ).toBe(true)
    })

    it('should return false for non-stratos URIs', () => {
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/app.bsky.feed.post/123',
        ),
      ).toBe(false)
      expect(
        StratosValidator.isStratosUri(
          'at://did:plc:abc/com.atproto.repo.record/123',
        ),
      ).toBe(false)
    })

    it('should return false for invalid URIs', () => {
      expect(StratosValidator.isStratosUri('')).toBe(false)
      expect(StratosValidator.isStratosUri('not-a-uri')).toBe(false)
      expect(StratosValidator.isStratosUri('https://example.com')).toBe(false)
    })
  })

  describe('isBskyUri', () => {
    it('should return true for bsky URIs', () => {
      expect(
        StratosValidator.isBskyUri('at://did:plc:abc/app.bsky.feed.post/123'),
      ).toBe(true)
      expect(
        StratosValidator.isBskyUri(
          'at://did:plc:abc/app.bsky.actor.profile/self',
        ),
      ).toBe(true)
    })

    it('should return false for non-bsky URIs', () => {
      expect(
        StratosValidator.isBskyUri(
          'at://did:plc:abc/zone.stratos.feed.post/123',
        ),
      ).toBe(false)
      expect(
        StratosValidator.isBskyUri(
          'at://did:plc:abc/com.atproto.repo.record/123',
        ),
      ).toBe(false)
    })

    it('should return false for invalid URIs', () => {
      expect(StratosValidator.isBskyUri('')).toBe(false)
      expect(StratosValidator.isBskyUri('not-a-uri')).toBe(false)
    })
  })

  describe('isStratosCollection', () => {
    it('should return true for stratos collections', () => {
      expect(
        StratosValidator.isStratosCollection('zone.stratos.feed.post'),
      ).toBe(true)
      expect(
        StratosValidator.isStratosCollection('zone.stratos.actor.profile'),
      ).toBe(true)
      expect(
        StratosValidator.isStratosCollection(
          'zone.stratos.some.future.collection',
        ),
      ).toBe(true)
    })

    it('should return false for non-stratos collections', () => {
      expect(StratosValidator.isStratosCollection('app.bsky.feed.post')).toBe(
        false,
      )
      expect(
        StratosValidator.isStratosCollection('com.atproto.repo.record'),
      ).toBe(false)
      expect(StratosValidator.isStratosCollection('')).toBe(false)
    })
  })

  describe('extractBoundaryDomains', () => {
    it('should extract domains from valid boundary', () => {
      const record = {
        boundary: {
          values: [
            { value: 'did:web:nerv.tokyo.jp/example-com' },
            { value: 'did:web:nerv.tokyo.jp/bunnies-example-com' },
          ],
        },
      }

      expect(StratosValidator.extractBoundaryDomains(record)).toEqual([
        'did:web:nerv.tokyo.jp/example-com',
        'did:web:nerv.tokyo.jp/bunnies-example-com',
      ])
    })

    it('should return empty array for missing boundary', () => {
      expect(StratosValidator.extractBoundaryDomains({})).toEqual([])
      expect(
        StratosValidator.extractBoundaryDomains({ text: 'hello' }),
      ).toEqual([])
    })

    it('should return empty array for empty boundary values', () => {
      expect(StratosValidator.extractBoundaryDomains({ boundary: {} })).toEqual(
        [],
      )
      expect(
        StratosValidator.extractBoundaryDomains({ boundary: { values: [] } }),
      ).toEqual([])
    })
  })
})
