import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PdsSubscription, parseCid, jsonToLex } from '../src/pds-subscription.ts'
import {
  createMockIndexingService,
  createMockBackgroundQueue,
  createMockEnrollmentCallback,
  createEnrollmentRecord,
  SPIKE_DID,
  FAYE_DID,
  JET_DID,
  USAGI_DID,
  BEBOP_PDS,
  STRATOS_SERVICE_URL,
} from './helpers/mocks.ts'
import { CID } from 'multiformats/cid'

// Mock partysocket to avoid real WebSocket connections
vi.mock('partysocket', () => {
  class MockWebSocket {
    url: string
    binaryType = 'arraybuffer'
    onmessage: ((e: { data: unknown }) => void) | null = null
    onerror: ((e: { error?: unknown }) => void) | null = null
    onclose: (() => void) | null = null
    onopen: (() => void) | null = null
    close = vi.fn()
    addEventListener = vi.fn()

    constructor(url: string) {
      this.url = url
    }
  }

  return { WebSocket: MockWebSocket }
})

describe('PDS Subscription', () => {
  let indexingService: ReturnType<typeof createMockIndexingService>
  let background: ReturnType<typeof createMockBackgroundQueue>
  let enrollmentCallback: ReturnType<typeof createMockEnrollmentCallback>

  beforeEach(() => {
    indexingService = createMockIndexingService()
    background = createMockBackgroundQueue()
    enrollmentCallback = createMockEnrollmentCallback()
  })

  describe('PdsSubscription', () => {
    it('should construct with correct initial cursor', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
        cursor: 42,
      })

      expect(sub.getCursor()).toBe('42')
    })

    it('should default to empty cursor when none provided', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      expect(sub.getCursor()).toBe('')
    })

    it('should stop cleanly', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      sub.start()
      sub.stop()
      // Verifies no error thrown
    })
  })

  describe('enrollment discovery', () => {
    it('should detect enrollment create from commit ops', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      const enrollmentRecord = createEnrollmentRecord(STRATOS_SERVICE_URL, [
        'engineering',
      ])

      // Access the private method through the prototype chain
      const checkMethod = (
        sub as unknown as {
          checkEnrollmentOp: (
            did: string,
            op: { path: string; record?: Record<string, unknown> },
            action: string,
          ) => void
        }
      ).checkEnrollmentOp.bind(sub)

      checkMethod(
        SPIKE_DID,
        {
          path: 'zone.stratos.actor.enrollment/self',
          record: enrollmentRecord,
        },
        'create',
      )

      expect(enrollmentCallback.onEnrollmentDiscovered).toHaveBeenCalledWith(
        SPIKE_DID,
        STRATOS_SERVICE_URL,
        ['engineering'],
      )
    })

    it('should detect enrollment delete from commit ops', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      const checkMethod = (
        sub as unknown as {
          checkEnrollmentOp: (
            did: string,
            op: { path: string; record?: Record<string, unknown> },
            action: string,
          ) => void
        }
      ).checkEnrollmentOp.bind(sub)

      checkMethod(
        FAYE_DID,
        { path: 'zone.stratos.actor.enrollment/self' },
        'delete',
      )

      expect(enrollmentCallback.onEnrollmentRemoved).toHaveBeenCalledWith(
        FAYE_DID,
      )
    })

    it('should not trigger enrollment callback for non-enrollment records', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      const checkMethod = (
        sub as unknown as {
          checkEnrollmentOp: (
            did: string,
            op: { path: string; record?: Record<string, unknown> },
            action: string,
          ) => void
        }
      ).checkEnrollmentOp.bind(sub)

      checkMethod(
        JET_DID,
        {
          path: 'app.bsky.feed.post/abc123',
          record: { text: 'see you space cowboy' },
        },
        'create',
      )

      expect(enrollmentCallback.onEnrollmentDiscovered).not.toHaveBeenCalled()
      expect(enrollmentCallback.onEnrollmentRemoved).not.toHaveBeenCalled()
    })

    it('should extract boundaries from enrollment record', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      const checkMethod = (
        sub as unknown as {
          checkEnrollmentOp: (
            did: string,
            op: { path: string; record?: Record<string, unknown> },
            action: string,
          ) => void
        }
      ).checkEnrollmentOp.bind(sub)

      checkMethod(
        USAGI_DID,
        {
          path: 'zone.stratos.actor.enrollment/self',
          record: createEnrollmentRecord(STRATOS_SERVICE_URL, [
            'moonkingdom',
            'crystaltokyo',
          ]),
        },
        'create',
      )

      expect(enrollmentCallback.onEnrollmentDiscovered).toHaveBeenCalledWith(
        USAGI_DID,
        STRATOS_SERVICE_URL,
        ['moonkingdom', 'crystaltokyo'],
      )
    })

    it('should not trigger enrollment when service URL is empty', () => {
      const sub = new PdsSubscription({
        service: BEBOP_PDS,
        indexingService: indexingService as never,
        background: background as never,
        enrollmentCallback,
      })

      const checkMethod = (
        sub as unknown as {
          checkEnrollmentOp: (
            did: string,
            op: { path: string; record?: Record<string, unknown> },
            action: string,
          ) => void
        }
      ).checkEnrollmentOp.bind(sub)

      checkMethod(
        SPIKE_DID,
        {
          path: 'zone.stratos.actor.enrollment/self',
          record: { $type: 'zone.stratos.actor.enrollment' },
        },
        'create',
      )

      expect(enrollmentCallback.onEnrollmentDiscovered).not.toHaveBeenCalled()
    })
  })
})

describe('CBOR/CAR Utilities', () => {
  describe('parseCid', () => {
    it('should parse a CID string', () => {
      const cidStr =
        'bafyreihffx5a2e5m3j6ybqkbhaso4mxn32uqkfsmihqfxpba3lprfo4vbi'
      const result = parseCid(cidStr)
      expect(result).toBeInstanceOf(CID)
      expect(result.toString()).toBe(cidStr)
    })

    it('should parse a CID $link object', () => {
      const cidStr =
        'bafyreihffx5a2e5m3j6ybqkbhaso4mxn32uqkfsmihqfxpba3lprfo4vbi'
      const result = parseCid({ $link: cidStr })
      expect(result.toString()).toBe(cidStr)
    })

    it('should pass through a CID instance', () => {
      const cidStr =
        'bafyreihffx5a2e5m3j6ybqkbhaso4mxn32uqkfsmihqfxpba3lprfo4vbi'
      const cid = CID.parse(cidStr)
      const result = parseCid(cid)
      expect(result).toBe(cid)
    })

    it('should throw for invalid CID', () => {
      expect(() => parseCid({} as never)).toThrow('invalid CID')
    })
  })

  describe('jsonToLex', () => {
    it('should pass through primitive values', () => {
      expect(jsonToLex('hello' as never)).toBe('hello')
      expect(jsonToLex(42 as never)).toBe(42)
      expect(jsonToLex(null as never)).toBe(null)
    })

    it('should recursively process objects', () => {
      const input = { text: 'hello', nested: { value: 'world' } }
      const result = jsonToLex(input)
      expect(result).toEqual({ text: 'hello', nested: { value: 'world' } })
    })

    it('should convert $link objects to CIDs', () => {
      const cidStr =
        'bafyreihffx5a2e5m3j6ybqkbhaso4mxn32uqkfsmihqfxpba3lprfo4vbi'
      const input = { ref: { $link: cidStr } }
      const result = jsonToLex(input) as { ref: CID }
      expect(result.ref).toBeInstanceOf(CID)
      expect(result.ref.toString()).toBe(cidStr)
    })

    it('should process arrays', () => {
      const input = [{ text: 'one' }, { text: 'two' }]
      const result = jsonToLex(input as never)
      expect(result).toEqual([{ text: 'one' }, { text: 'two' }])
    })
  })
})
