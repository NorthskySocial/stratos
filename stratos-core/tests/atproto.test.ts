import { describe, expect, it } from 'vitest'
import { CID } from '@atproto/lex-data'
import {
  computeCid,
  decodeCommitOps,
  encodeRecord,
  extractBoundaries,
  jsonToLex,
  parseCid,
} from '../src'
import { collectCarStream, makeCidStr } from './utils'

describe('ATProto Utilities', () => {
  describe('decodeCommitOps', () => {
    it('should decode create operations from a CAR file', async () => {
      const record = {
        $type: 'zone.stratos.feed.post',
        text: 'See you Space Cowboy...',
        createdAt: '1998-04-03T00:00:00Z',
      }
      const recordBytes = encodeRecord(record)
      const cid = await computeCid(record)
      const cidStr = cid.toString()

      const carBytes = await collectCarStream(
        [{ $link: cidStr }],
        [{ cid: cid.bytes, data: recordBytes }],
      )

      const ops = [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/rkey123',
          cid: { $link: cidStr },
        },
      ]

      const decoded = decodeCommitOps(carBytes, ops)
      expect(decoded).toHaveLength(1)
      expect(decoded[0]).toEqual({
        action: 'create',
        path: 'zone.stratos.feed.post/rkey123',
        collection: 'zone.stratos.feed.post',
        rkey: 'rkey123',
        cid: cidStr,
        record: record,
      })
    })

    it('should handle delete operations', () => {
      const ops = [
        {
          action: 'delete',
          path: 'zone.stratos.feed.post/rkey123',
        },
      ]

      const decoded = decodeCommitOps(new Uint8Array(0), ops)
      expect(decoded).toHaveLength(1)
      expect(decoded[0]).toEqual({
        action: 'delete',
        path: 'zone.stratos.feed.post/rkey123',
        collection: 'zone.stratos.feed.post',
        rkey: 'rkey123',
      })
    })

    it('should return empty array for empty blocks', () => {
      const ops = [{ action: 'create', path: 'a/b', cid: 'cid' }]
      expect(decodeCommitOps(new Uint8Array(0), ops)).toEqual([])
    })

    it('should skip operations with missing records in CAR', async () => {
      const cidStr = await makeCidStr('missing')
      const ops = [
        {
          action: 'create',
          path: 'zone.stratos.feed.post/rkey123',
          cid: cidStr,
        },
      ]
      // Empty CAR but has ops
      const carBytes = await collectCarStream([], [])
      const decoded = decodeCommitOps(carBytes, ops)
      expect(decoded).toHaveLength(0)
    })
  })

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

    it('should handle non-string or missing values in boundaries', () => {
      const record = {
        boundary: {
          values: [{ value: 'nerv' }, { value: 123 }, {}, { value: null }],
        },
      }
      expect(extractBoundaries(record as any)).toEqual(['nerv'])
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

    it('should handle CID-like objects with version and multihash', async () => {
      const record = { unit: '00' }
      const realCid = await computeCid(record)
      // Pass the CID object itself (LexCid/CID)
      expect(parseCid(realCid).toString()).toBe(realCid.toString())
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

    it('should convert JSON with $bytes to Uint8Array', () => {
      const json = {
        data: { $bytes: 'SGVsbG8sIEV2YW5nZWxpb24h' }, // "Hello, Evangelion!" in base64
      }
      const lex = jsonToLex(json) as Record<string, unknown>
      expect(lex.data).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(lex.data as Uint8Array)).toBe(
        'Hello, Evangelion!',
      )
    })

    it('should handle nested arrays and objects', async () => {
      const cid = await computeCid({ b: 2 })
      const json = {
        list: [{ item: { $link: cid.toString() } }, 'simple string', 42],
      }
      const lex = jsonToLex(json) as Record<string, any>
      expect(lex.list[0].item).toBeInstanceOf(CID)
      expect(lex.list[1]).toBe('simple string')
      expect(lex.list[2]).toBe(42)
    })

    it('should return null/non-objects as is', () => {
      expect(jsonToLex(null as any)).toBe(null)
      expect(jsonToLex('string' as any)).toBe('string')
      expect(jsonToLex(123 as any)).toBe(123)
    })
  })
})
