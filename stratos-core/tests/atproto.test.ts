import { describe, expect, it } from 'vitest'
import { CID } from '@atproto/lex-data'
import {
  computeCid,
  encodeRecord,
  extractBoundaries,
  jsonToLex,
  parseCid,
} from '../src/atproto/index.js'

describe('ATProto Utilities', () => {
  describe('encodeRecord and computeCid', () => {
    it('should encode a record and compute its CID consistently', async () => {
      const record = {
        $type: 'zone.stratos.feed.post',
        text: 'Hello, Cowboy Bebop!',
        createdAt: '1998-04-03T00:00:00Z',
      }

      const bytes = encodeRecord(record)
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)

      const cid = await computeCid(record)
      expect(cid).toBeInstanceOf(CID)
      expect(cid.toString()).toMatch(/^bafyrei/)

      // Consistency check
      const cid2 = await computeCid(record)
      expect(cid.toString()).toBe(cid2.toString())
    })

    it('should handle nested records', async () => {
      const record = {
        $type: 'zone.stratos.feed.post',
        text: 'Nested',
        facets: [
          {
            index: { byteStart: 0, byteEnd: 6 },
            features: [
              {
                $type: 'zone.stratos.richtext.facet#link',
                uri: 'https://example.com',
              },
            ],
          },
        ],
      }
      const cid = await computeCid(record)
      expect(cid).toBeInstanceOf(CID)
    })
  })

  describe('extractBoundaries', () => {
    it('should extract boundaries from a record', () => {
      const record = {
        boundary: {
          values: [{ value: 'engineering' }, { value: 'leadership' }],
        },
      }
      const boundaries = extractBoundaries(record)
      expect(boundaries).toEqual(['engineering', 'leadership'])
    })

    it('should return empty array if no boundaries', () => {
      expect(extractBoundaries({})).toEqual([])
      expect(extractBoundaries({ boundary: {} })).toEqual([])
      expect(extractBoundaries({ boundary: { values: [] } })).toEqual([])
    })
  })

  describe('parseCid', () => {
    it('should parse various CID formats', async () => {
      const record = { foo: 'bar' }
      const realCid = await computeCid(record)
      const realCidStr = realCid.toString()

      expect(parseCid(realCidStr).toString()).toBe(realCidStr)
      expect(parseCid(realCid).toString()).toBe(realCidStr)
      expect(parseCid({ $link: realCidStr }).toString()).toBe(realCidStr)
      expect(parseCid({ bytes: realCid.bytes }).toString()).toBe(realCidStr)
    })

    it('should throw on invalid CID', () => {
      expect(() => parseCid('invalid')).toThrow()
    })
  })

  describe('jsonToLex', () => {
    it('should convert JSON with $link to Lexicon value', async () => {
      const cid = await computeCid({ a: 1 })
      const json = {
        ref: { $link: cid.toString() },
        other: 'value',
      }
      const lex = jsonToLex(json) as Record<string, unknown>
      expect(lex.ref).toBeInstanceOf(CID)
      expect((lex.ref as CID).toString()).toBe(cid.toString())
      expect(lex.other).toBe('value')
    })
  })
})
