/**
 * Tests for CBOR encoding/decoding roundtrip in subscription stream.
 *
 * Events are stored CBOR-encoded in stratos_seq.event (via cborEncode in
 * records.ts). The subscription handler must CBOR-decode them, not
 * JSON.parse. These tests verify the roundtrip works correctly.
 */
import { describe, expect, it } from 'vitest'
import { encode as cborEncode, type LexValue } from '@atproto/lex-cbor'
import {
  decodeEvent,
  eventInScope,
  eventVisibleToCaller,
  formatEvent,
  hasBoundaryIntersection,
  type SeqEvent,
} from '../src/subscription/index.js'
import type { EnrollmentEvent } from '../src/context-types.js'

function createCborEvent(event: Record<string, unknown>): Uint8Array {
  return new Uint8Array(cborEncode(event as unknown as LexValue))
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
      expect((result.ops[0].record as any)?.text).toBe(
        'Shinji, get in the robot!',
      )
    })

    it('decodes CBOR-encoded event with multiple ops', () => {
      const eventData = {
        rev: 'rev456',
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/a',
            cid: 'cid1',
            record: { text: 'First post' },
          },
          {
            action: 'create',
            path: 'zone.stratos.feed.post/b',
            cid: 'cid2',
            record: { text: 'Second post' },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      const result = formatEvent(seqEvent)

      expect(result.ops).toHaveLength(2)
      expect((result.ops[0].record as any)?.text).toBe('First post')
      expect((result.ops[1].record as any)?.text).toBe('Second post')
    })

    it('returns empty ops for invalid CBOR data', () => {
      const seqEvent = createSeqEvent(
        {},
        {
          event: new Uint8Array([0xff, 0xfe, 0xfd]),
        },
      )
      const result = formatEvent(seqEvent)

      expect(result.ops).toEqual([])
    })
  })

  describe('decodeEvent', () => {
    it('decodes ops and the union of boundary values', () => {
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

      const decoded = decodeEvent(createSeqEvent(eventData))
      expect(decoded.decodeOk).toBe(true)
      expect(decoded.ops).toHaveLength(2)
      expect([...decoded.boundaries].sort()).toEqual(['nerv', 'seele'])
    })

    it('decodes a bare record payload that has no ops wrapper', () => {
      // Some events are stored as a single record object rather than an
      // { ops: [...] } envelope; decodeEvent must treat the payload as one op.
      const bareRecord = {
        action: 'create',
        path: 'zone.stratos.feed.post/solo',
        record: { boundary: { values: [{ value: 'nerv' }] } },
      }

      const decoded = decodeEvent(createSeqEvent(bareRecord))
      expect(decoded.decodeOk).toBe(true)
      expect(decoded.ops).toHaveLength(1)
      expect(decoded.boundaries).toEqual(['nerv'])
    })

    it('fails closed with empty ops and boundaries on invalid CBOR', () => {
      const decoded = decodeEvent(
        createSeqEvent({}, { event: new Uint8Array([0xff, 0xfe, 0xfd]) }),
      )
      expect(decoded.decodeOk).toBe(false)
      expect(decoded.ops).toEqual([])
      expect(decoded.boundaries).toEqual([])
    })
  })

  describe('eventInScope (boundary-set filtering)', () => {
    it('denies a decode-failed event even if boundaries are populated', () => {
      // Defence in depth: decodeOk === false must deny regardless of any
      // boundary values that might be present on the decoded shape.
      const decoded = {
        ops: [],
        boundaries: ['nerv'],
        decodeOk: false,
      }
      expect(eventInScope(decoded, new Set(['nerv']))).toBe(false)
    })

    it('matches event with a shared boundary', () => {
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
      const decoded = decodeEvent(seqEvent)
      expect(eventInScope(decoded, new Set(['swordsmith']))).toBe(true)
    })

    it('does not match event with no shared boundary', () => {
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
      const decoded = decodeEvent(seqEvent)
      expect(eventInScope(decoded, new Set(['aekea']))).toBe(false)
    })

    it('matches when any op shares a boundary with the caller', () => {
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
      const decoded = decodeEvent(seqEvent)
      expect(eventInScope(decoded, new Set(['seele']))).toBe(true)
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
      const decoded = decodeEvent(seqEvent)
      expect(eventInScope(decoded, new Set(['aekea']))).toBe(true)
      expect(eventInScope(decoded, new Set(['swordsmith']))).toBe(true)
    })

    it('narrows by the optional domain within the shared set', () => {
      const eventData = {
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/abc',
            record: {
              boundary: {
                values: [{ value: 'nerv' }, { value: 'seele' }],
              },
            },
          },
        ],
      }

      const seqEvent = createSeqEvent(eventData)
      const decoded = decodeEvent(seqEvent)
      const caller = new Set(['nerv', 'seele'])
      expect(eventInScope(decoded, caller, 'nerv')).toBe(true)
      expect(eventInScope(decoded, caller, 'aekea')).toBe(false)
    })

    it('drops undecodable data (fail closed)', () => {
      const seqEvent = createSeqEvent(
        {},
        {
          event: new Uint8Array([0xff, 0xfe, 0xfd]),
        },
      )
      const decoded = decodeEvent(seqEvent)
      expect(decoded.decodeOk).toBe(false)
      expect(eventInScope(decoded, new Set(['anything']))).toBe(false)
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
      const decoded = decodeEvent(seqEvent)
      expect(eventInScope(decoded, new Set(['swordsmith']))).toBe(false)
    })
  })

  describe('hasBoundaryIntersection', () => {
    it('is true when sets intersect', () => {
      expect(
        hasBoundaryIntersection(new Set(['nerv', 'seele']), ['seele']),
      ).toBe(true)
    })

    it('is false when sets are disjoint', () => {
      expect(hasBoundaryIntersection(new Set(['nerv']), ['seele'])).toBe(false)
    })

    it('is false for undefined boundaries', () => {
      expect(hasBoundaryIntersection(new Set(['nerv']), undefined)).toBe(false)
    })

    it('is false for empty boundaries', () => {
      expect(hasBoundaryIntersection(new Set(['nerv']), [])).toBe(false)
    })
  })

  // SWP-13: service-stream event scoping. A `boundaries` change must reach a
  // caller that held a NOW-REMOVED boundary even if the after-set no longer
  // intersects the caller — otherwise the caller never learns the actor left.
  describe('eventVisibleToCaller (SWP-13 boundary-change scoping)', () => {
    const mk = (e: Partial<EnrollmentEvent>): EnrollmentEvent => ({
      did: 'did:plc:actor',
      action: 'boundaries',
      time: '2026-07-02T00:00:00.000Z',
      ...e,
    })

    it('enroll follows plain after-set intersection', () => {
      expect(
        eventVisibleToCaller(
          new Set(['nerv']),
          mk({ action: 'enroll', boundaries: ['nerv', 'seele'] }),
        ),
      ).toBe(true)
      expect(
        eventVisibleToCaller(
          new Set(['nerv']),
          mk({ action: 'enroll', boundaries: ['seele'] }),
        ),
      ).toBe(false)
    })

    it('boundary shrink removing the last shared boundary is STILL delivered (prior intersects)', () => {
      // Caller holds `nerv`; actor moves from [nerv, seele] to [seele].
      // After-set [seele] does NOT intersect {nerv}, but prior does, so the
      // caller must still receive it to purge its `nerv`-scoped state.
      expect(
        eventVisibleToCaller(
          new Set(['nerv']),
          mk({ boundaries: ['seele'], priorBoundaries: ['nerv', 'seele'] }),
        ),
      ).toBe(true)
    })

    it('boundary change is delivered when the after-set intersects (grow into caller scope)', () => {
      expect(
        eventVisibleToCaller(
          new Set(['nerv']),
          mk({ boundaries: ['nerv', 'seele'], priorBoundaries: ['seele'] }),
        ),
      ).toBe(true)
    })

    it('boundary change touching neither prior nor after of the caller is dropped', () => {
      expect(
        eventVisibleToCaller(
          new Set(['nerv']),
          mk({ boundaries: ['seele'], priorBoundaries: ['aekea'] }),
        ),
      ).toBe(false)
    })
  })
})
