import { describe, expect, it } from 'vitest'
import { jsonToLex } from '@atproto/lexicon'
import {
  parseCid,
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

  describe('extractBlobs', () => {
    it('should extract blobs from various parts of a record', () => {
      const record = {
        text: 'hello',
        image: {
          $type: 'blob',
          ref: {
            $link:
              'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          },
          mimeType: 'image/jpeg',
          size: 12345,
        },
        nested: {
          another: {
            $type: 'blob',
            ref: {
              $link:
                'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzvev6wt667vyrp7k4p72e',
            },
            mimeType: 'application/octet-stream',
            size: 678,
          },
        },
        array: [
          {
            $type: 'blob',
            ref: {
              $link:
                'bafybeig6xv5nwuj7vjndjshyr2u6x7v7uv7uv7uv7uv7uv7uv7uv7uv7uv',
            },
            mimeType: 'image/png',
            size: 999,
          },
          'just a string',
          {
            nestedInArray: {
              $type: 'blob',
              ref: {
                $link:
                  'bafybeicvpx5nwuj7vjndjshyr2u6x7v7uv7uv7uv7uv7uv7uv7uv7uv7uv',
              },
              mimeType: 'image/webp',
              size: 444,
            },
          },
        ],
      }

      const blobs = StratosValidator.extractBlobs(record)
      expect(blobs).toHaveLength(4)
      expect(blobs).toContain(
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      )
      expect(blobs).toContain(
        'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzvev6wt667vyrp7k4p72e',
      )
      expect(blobs).toContain(
        'bafybeig6xv5nwuj7vjndjshyr2u6x7v7uv7uv7uv7uv7uv7uv7uv7uv7uv',
      )
      expect(blobs).toContain(
        'bafybeicvpx5nwuj7vjndjshyr2u6x7v7uv7uv7uv7uv7uv7uv7uv7uv7uv',
      )
    })

    it('should return empty array if no blobs are found', () => {
      const record = {
        text: 'hello',
        notABlob: {
          $type: 'not-blob',
          ref: {
            $link:
              'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
          },
        },
      }
      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should handle null and undefined', () => {
      expect(StratosValidator.extractBlobs(null)).toEqual([])
      expect(StratosValidator.extractBlobs(undefined)).toEqual([])
      expect(StratosValidator.extractBlobs({ foo: null })).toEqual([])
    })

    // The XRPC server runs jsonToLex on JSON bodies before handlers run.
    // A blob then arrives as a BlobRef instance without the $type marker.
    it('should extract blobs from a lex-converted body', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const wire = {
        $type: 'zone.stratos.feed.post',
        text: 'Rei forges a katana at the Hikawa shrine',
        embed: {
          $type: 'zone.stratos.embed.images',
          images: [
            {
              image: {
                $type: 'blob',
                ref: { $link: cidStr },
                mimeType: 'image/png',
                size: 2048,
              },
            },
          ],
        },
      }

      const lex = jsonToLex(wire)
      expect(StratosValidator.extractBlobs(lex)).toEqual([cidStr])
    })

    it('should extract a blob whose ref is a parsed CID object', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const record = {
        avatar: {
          ref: parseCid(cidStr),
          mimeType: 'image/jpeg',
          size: 512,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([cidStr])
    })

    it('should skip a lex lookalike whose ref is not a CID and still recurse', () => {
      const nestedCid =
        'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      const record = {
        lookalike: {
          ref: { some: 'object' },
          mimeType: 'image/png',
          size: 2048,
          inner: {
            $type: 'blob',
            ref: { $link: nestedCid },
            mimeType: 'image/jpeg',
            size: 1,
          },
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([nestedCid])
    })

    it('should not extract a CID ref that lacks blob fields', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const record = { subject: { ref: parseCid(cidStr) } }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    // extractBlobs runs inside the write transaction. A malformed blob
    // shape must not throw, and a near-miss shape must not associate.
    it('should skip a blob whose ref is a string', () => {
      const record = {
        image: {
          $type: 'blob',
          ref: 'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe',
          mimeType: 'image/png',
          size: 1,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a blob whose ref is null', () => {
      const record = {
        image: { $type: 'blob', ref: null, mimeType: 'image/png', size: 1 },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a blob whose $link is not a string', () => {
      const record = {
        image: {
          $type: 'blob',
          ref: { $link: 123 },
          mimeType: 'image/png',
          size: 1,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a $link ref without the blob $type marker', () => {
      const record = {
        image: {
          ref: {
            $link:
              'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe',
          },
          mimeType: 'image/png',
          size: 5,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a CID ref whose mimeType is not a string', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const record = {
        image: { ref: parseCid(cidStr), mimeType: 42, size: 5 },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a CID ref whose size is not a number', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const record = {
        image: { ref: parseCid(cidStr), mimeType: 'image/png', size: 'big' },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })
  })
})
