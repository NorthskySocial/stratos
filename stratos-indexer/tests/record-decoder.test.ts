import { describe, expect, it } from 'vitest'
import {
  extractBoundaries,
  jsonToLex,
  parseCid,
} from '@northskysocial/stratos-core'

describe('extractBoundaries', () => {
  it('extracts boundary values from a record', () => {
    const record = {
      $type: 'zone.stratos.feed.post',
      text: 'hello from nerv',
      boundary: {
        values: [
          { value: 'did:web:nerv.tokyo.jp/engineering' },
          { value: 'did:web:nerv.tokyo.jp/leadership' },
        ],
      },
    }

    expect(extractBoundaries(record)).toEqual([
      'did:web:nerv.tokyo.jp/engineering',
      'did:web:nerv.tokyo.jp/leadership',
    ])
  })

  it('returns empty array when no boundary field', () => {
    expect(extractBoundaries({ text: 'hello' })).toEqual([])
  })

  it('returns empty array when boundary has no values', () => {
    expect(extractBoundaries({ boundary: {} })).toEqual([])
  })

  it('filters out non-string values', () => {
    const record = {
      boundary: {
        values: [
          { value: 'did:web:nerv.tokyo.jp/valid' },
          { value: 42 },
          {},
          { value: null },
        ],
      },
    }
    expect(extractBoundaries(record as never)).toEqual([
      'did:web:nerv.tokyo.jp/valid',
    ])
  })
})

describe('parseCid', () => {
  const cidStr = 'bafyreie5cvv4h45feadgeuwhbcutmh6t7ceseocckahdoe6uat64zmz454'

  it('parses a CID string', () => {
    const cid = parseCid(cidStr)
    expect(cid.toString()).toBe(cidStr)
  })

  it('parses a $link object', () => {
    const cid = parseCid({ $link: cidStr })
    expect(cid.toString()).toBe(cidStr)
  })

  it('returns a CID object as-is', () => {
    const original = parseCid(cidStr)
    const result = parseCid(original)
    // Use toEqual as we now return a new object (LexCid)
    expect(result).toEqual(original)
  })

  it('parses a bytes object', () => {
    const original = parseCid(cidStr)
    const cid = parseCid({ bytes: original.bytes })
    expect(cid.toString()).toBe(cidStr)
  })

  it('throws on invalid input', () => {
    expect(() => parseCid({} as never)).toThrow('invalid CID')
  })
})

describe('jsonToLex', () => {
  it('converts $link objects to CID instances', () => {
    const cidStr = 'bafyreie5cvv4h45feadgeuwhbcutmh6t7ceseocckahdoe6uat64zmz454'
    const result = jsonToLex({ $link: cidStr })
    expect(result).toBeDefined()
    expect(String(result)).toBe(cidStr)
  })

  it('passes through primitive values', () => {
    expect(jsonToLex('hello' as never)).toBe('hello')
    expect(jsonToLex(42 as never)).toBe(42)
    expect(jsonToLex(null as never)).toBe(null)
  })

  it('recursively processes nested objects', () => {
    const result = jsonToLex({
      text: 'test',
      nested: { value: 123 },
    }) as Record<string, unknown>

    expect(result.text).toBe('test')
    expect((result.nested as Record<string, unknown>).value).toBe(123)
  })

  it('processes arrays', () => {
    const result = jsonToLex([{ text: 'a' }, { text: 'b' }] as never)
    expect(Array.isArray(result)).toBe(true)
    expect((result as Array<Record<string, unknown>>)[0].text).toBe('a')
  })
})
