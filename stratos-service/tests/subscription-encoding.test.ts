/**
 * Tests for CBOR encoding/decoding roundtrip in subscription stream.
 *
 * Events are stored CBOR-encoded in stratos_seq.event (via cborEncode in
 * records.ts). The subscription handler must CBOR-decode them, not
 * JSON.parse. These tests verify the roundtrip works correctly.
 */
import { describe, it, expect } from 'vitest'
import { encode as cborEncode } from '@atproto/lex-cbor'
import {
  formatEvent,
  matchesDomain,
  type SeqEvent,
} from '../src/subscription/subscribe-records.js'

function createCborEvent(
  event: Record<string, unknown>,
): Uint8Array {
  return new Uint8Array(cborEncode(event))
}

function createSeqEvent(
  eventData: Record<string, unknown>,
  overrides: Partial<SeqEvent> = {},
): SeqEvent {
  return {
    seq: 1,
    did: 'did:plc:rei-ayanami',
    time: '2025-01-15T00:00:00.000Z',
    rev: 'abc123',
    event: createCborEvent(eventData),
    ...overrides,
  }
}

describe('Subscription CBOR encoding roundtrip', () => {
  describe('formatEvent', () => {
    it('decodes CBOR-encoded event with ops array', () => {
      const eventData = {
        rev: 'rev123',
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/abc',
            cid: 'bafyrei123',
            record: {
              $type: 'zone.stratos.feed.post',
              text: 'Shinji, get in the robot!',
              boundary: { values: [{ value: 'nerv' }] },
              createdAt: '2025-01-15T00:00:00.000Z',
            },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      const result = formatEvent(seqEvent)

      expect(result.$type).toBe('zone.stratos.sync.subscribeRecords#commit')
      expect(result.seq).toBe(1)
      expect(result.did).toBe('did:plc:rei-ayanami')
      expect(result.ops).toHaveLength(1)
      expect(result.ops[0].action).toBe('create')
      expect(result.ops[0].path).toBe('zone.stratos.feed.post/abc')
      expect(result.ops[0].record?.text).toBe('Shinji, get in the robot!')
    })

    it('decodes CBOR-encoded event with multiple ops', () => {
      const eventData = {
        rev: 'rev456',
        ops: [
          { action: 'create', path: 'zone.stratos.feed.post/a', cid: 'cid1', record: { text: 'First post' } },
          { action: 'create', path: 'zone.stratos.feed.post/b', cid: 'cid2', record: { text: 'Second post' } },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      const result = formatEvent(seqEvent)

      expect(result.ops).toHaveLength(2)
      expect(result.ops[0].record?.text).toBe('First post')
      expect(result.ops[1].record?.text).toBe('Second post')
    })

    it('returns empty ops for invalid CBOR data', () => {
      const seqEvent = createSeqEvent({}, {
        event: new Uint8Array([0xFF, 0xFE, 0xFD]),
      })
      const result = formatEvent(seqEvent)

      expect(result.ops).toEqual([])
    })
  })

  describe('matchesDomain', () => {
    it('matches event with matching boundary domain', () => {
      const eventData = {
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/abc',
            record: {
              boundary: { values: [{ value: 'swordsmith' }] },
            },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      expect(matchesDomain(seqEvent, 'swordsmith')).toBe(true)
    })

    it('does not match event with different boundary domain', () => {
      const eventData = {
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/abc',
            record: {
              boundary: { values: [{ value: 'swordsmith' }] },
            },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      expect(matchesDomain(seqEvent, 'aekea')).toBe(false)
    })

    it('matches when any op has the requested domain', () => {
      const eventData = {
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/a',
            record: { boundary: { values: [{ value: 'nerv' }] } },
          },
          {
            action: 'create',
            path: 'zone.stratos.feed.post/b',
            record: { boundary: { values: [{ value: 'seele' }] } },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      expect(matchesDomain(seqEvent, 'seele')).toBe(true)
    })

    it('matches with multiple boundary values on a single record', () => {
      const eventData = {
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/abc',
            record: {
              boundary: {
                values: [{ value: 'swordsmith' }, { value: 'aekea' }],
              },
            },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      expect(matchesDomain(seqEvent, 'aekea')).toBe(true)
      expect(matchesDomain(seqEvent, 'swordsmith')).toBe(true)
    })

    it('returns true for undecable data (fail-open)', () => {
      const seqEvent = createSeqEvent({}, {
        event: new Uint8Array([0xFF, 0xFE, 0xFD]),
      })
      expect(matchesDomain(seqEvent, 'anything')).toBe(true)
    })

    it('returns false when ops have no boundary', () => {
      const eventData = {
        ops: [
          {
            action: 'delete',
            path: 'zone.stratos.feed.post/abc',
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      expect(matchesDomain(seqEvent, 'swordsmith')).toBe(false)
    })
  })
})
