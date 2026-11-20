import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { AtUri } from '@atproto/syntax'
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

    it('should pass for a stratos post replying to a PDS-hosted space record', () => {
      const spacePostUri =
        'at:space/did:web:stratos.atverkackt.de/zone.stratos.space.feed/general/did:plc:or5elrbod5l4vq66ol4gy2eb/zone.stratos.feed.post/3mup74hqt3w25'
      const record = {
        text: "I'm on a non-space PDS and yet this is all private?!",
        boundary: {
          values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }],
        },
        reply: {
          parent: { uri: spacePostUri, cid: 'bafyreicnquudovolfjexydvy' },
          root: { uri: spacePostUri, cid: 'bafyreicnquudovolfjexydvy' },
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
                'bafkreic2b545qkwlmlk4zv5ffieyptk2xnr7xpoz6dist6lfggdrn5rlrm',
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
                  'bafkreieaexcoxldrbo56cxq76uejbt4kzgfeuotbpidsmkisgcv4q5owsa',
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
        'bafkreic2b545qkwlmlk4zv5ffieyptk2xnr7xpoz6dist6lfggdrn5rlrm',
      )
      expect(blobs).toContain(
        'bafkreieaexcoxldrbo56cxq76uejbt4kzgfeuotbpidsmkisgcv4q5owsa',
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

    it('should skip a $link ref whose $type is not blob', () => {
      const record = {
        image: {
          $type: 'file',
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

    it('should skip a $link that holds a CID object instead of a string', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const record = {
        image: {
          $type: 'blob',
          ref: { $link: parseCid(cidStr) },
          mimeType: 'image/png',
          size: 5,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should return each blob CID once when the record repeats it', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const blob = {
        $type: 'blob',
        ref: { $link: cidStr },
        mimeType: 'image/png',
        size: 2048,
      }
      const record = { avatar: blob, banner: blob }

      expect(StratosValidator.extractBlobs(record)).toEqual([cidStr])
    })

    it('should dedupe a wire blob against its lex twin', () => {
      const cidStr =
        'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe'
      const record = {
        wire: {
          $type: 'blob',
          ref: { $link: cidStr },
          mimeType: 'image/png',
          size: 2048,
        },
        lex: { ref: parseCid(cidStr), mimeType: 'image/png', size: 2048 },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([cidStr])
    })

    it('should skip a wire blob whose $link does not parse as a CID', () => {
      const record = {
        image: {
          $type: 'blob',
          ref: { $link: 'not-a-cid-from-the-hikawa-shrine' },
          mimeType: 'image/png',
          size: 1,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a wire blob without a mimeType', () => {
      const record = {
        image: {
          $type: 'blob',
          ref: {
            $link:
              'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe',
          },
          size: 1,
        },
      }

      expect(StratosValidator.extractBlobs(record)).toEqual([])
    })

    it('should skip a wire blob without a numeric size', () => {
      const record = {
        image: {
          $type: 'blob',
          ref: {
            $link:
              'bafkreib3v5ekyzf6xqbxfnbvnbncnmedhqfhtwtvjm7ck4uc4d2sh6nzoe',
          },
          mimeType: 'image/png',
          size: 'big',
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

describe('post rule record URIs of both custodies', () => {
  const config: StratosConfig = {
    serviceDid: 'did:web:nerv.tokyo.jp',
    allowedDomains: ['did:web:nerv.tokyo.jp/example-com'],
    retentionDays: 90,
  }
  const validator = new StratosValidator(config)
  const corpus = JSON.parse(
    readFileSync(
      new URL(
        '../../test/spaces-alignment/november/fixtures/space-uri-conformance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { invalid: Array<{ name: string; input: string }> }
  const LEGACY_SPACE_RECORD_URI = corpus.invalid.find(
    (entry) => entry.name === 'the old spelling of a record',
  )?.input as string
  const space = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
  const author = 'did:plc:fayevalentine'
  const rows: Array<{
    name: string
    uri: string
    stratos: boolean
    bsky: boolean
  }> = [
    {
      name: 'a custody stratos post',
      uri: `at://${author}/zone.stratos.feed.post/3k`,
      stratos: true,
      bsky: false,
    },
    {
      name: 'a custody bsky post',
      uri: `at://${author}/app.bsky.feed.post/3k`,
      stratos: false,
      bsky: true,
    },
    {
      name: 'a space record of a stratos collection',
      uri: `${space}/${author}/zone.stratos.feed.post/3k`,
      stratos: true,
      bsky: false,
    },
    {
      name: 'a space record of a bsky collection',
      uri: `${space}/${author}/app.bsky.feed.post/3k`,
      stratos: false,
      bsky: true,
    },
    {
      name: 'a legacy space record',
      uri: LEGACY_SPACE_RECORD_URI,
      stratos: false,
      bsky: false,
    },
    {
      name: 'a string that is no URI',
      uri: 'hello',
      stratos: false,
      bsky: false,
    },
    {
      name: 'a seven-part at:// URI',
      uri: `at://${author}/zone.stratos.feed.post/3k/a/b/c`,
      stratos: false,
      bsky: false,
    },
    {
      name: 'a bsky record URI with a trailing part',
      uri: `at://${author}/app.bsky.feed.post/3k/extra`,
      stratos: false,
      bsky: true,
    },
    {
      name: 'a bsky collection URI without a record key',
      uri: `at://${author}/app.bsky.feed.post`,
      stratos: false,
      bsky: true,
    },
    {
      name: 'a bsky record URI with an upper-case scheme',
      uri: `AT://${author}/app.bsky.feed.post/3k`,
      stratos: false,
      bsky: true,
    },
    {
      name: 'a bsky record URI without a scheme',
      uri: `${author}/app.bsky.feed.post/3k`,
      stratos: false,
      bsky: true,
    },
  ]
  const boundary = { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] }
  const assertPost = (extra: Record<string, unknown>) =>
    validator.assertValid(
      { text: 'Sortie', boundary, ...extra },
      'zone.stratos.feed.post',
    )

  it.each(rows)('classifies $name', ({ uri, stratos, bsky }) => {
    expect(StratosValidator.isStratosUri(uri)).toBe(stratos)
    expect(StratosValidator.isBskyUri(uri)).toBe(bsky)
  })

  it.each(rows)('reply to $name', ({ uri, stratos }) => {
    const run = () =>
      assertPost({
        reply: { parent: { uri, cid: 'c' }, root: { uri, cid: 'c' } },
      })
    if (stratos) expect(run).not.toThrow()
    else
      expect(run).toThrow(
        expect.objectContaining({ code: 'CrossNamespaceReply' }),
      )
  })

  it.each(rows)('embed of $name', ({ uri, bsky }) => {
    const run = () => assertPost({ embed: { record: { uri, cid: 'c' } } })
    if (bsky)
      expect(run).toThrow(
        expect.objectContaining({ code: 'CrossNamespaceEmbed' }),
      )
    else expect(run).not.toThrow()
  })

  it.each(['parent', 'root'] as const)(
    'refuses a legacy space record as the reply %s alone',
    (field) => {
      const good = { uri: `at://${author}/zone.stratos.feed.post/3k`, cid: 'c' }
      const bad = { uri: LEGACY_SPACE_RECORD_URI, cid: 'c' }
      const reply =
        field === 'parent'
          ? { parent: bad, root: good }
          : { parent: good, root: bad }
      expect(() => assertPost({ reply })).toThrow(
        expect.objectContaining({ code: 'CrossNamespaceReply' }),
      )
    },
  )

  it('treats a legacy space record in a media embed as any string that names no collection', () => {
    expect(() =>
      assertPost({
        embed: {
          media: { record: { uri: LEGACY_SPACE_RECORD_URI, cid: 'c' } },
        },
      }),
    ).not.toThrow()
  })
})

describe('isBskyUri against the upstream parser', () => {
  const refusedBefore = (uri: string): boolean => {
    try {
      return new AtUri(uri).collection.startsWith('app.bsky.')
    } catch {
      return false
    }
  }
  const scheme = fc.constantFrom('at://', 'AT://', 'At://', '')
  const repo = fc.constantFrom('did:plc:spikespiegel', 'did:web:bebop.example')
  const collection = fc.constantFrom(
    'app.bsky.feed.post',
    'app.bsky.actor.profile',
    'zone.stratos.feed.post',
    'com.example.misc',
  )
  const tail = fc.array(fc.constantFrom('3k', 'self', 'faye', 'ein'), {
    maxLength: 4,
  })

  it('refuses every string with an upstream-readable bsky collection that it refused before', () => {
    fc.assert(
      fc.property(scheme, repo, collection, tail, (head, did, nsid, rest) => {
        const uri = `${head}${[did, nsid, ...rest].join('/')}`
        fc.pre(refusedBefore(uri))
        expect(StratosValidator.isBskyUri(uri)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it('refuses a bsky collection at any path depth from one to six parts', () => {
    fc.assert(
      fc.property(scheme, fc.integer({ min: 1, max: 6 }), (head, depth) => {
        const parts = ['did:plc:rei', 'app.bsky.feed.post', 'a', 'b', 'c', 'd']
        const uri = `${head}${parts.slice(0, depth).join('/')}`
        fc.pre(refusedBefore(uri))
        expect(StratosValidator.isBskyUri(uri)).toBe(true)
      }),
    )
  })
})
