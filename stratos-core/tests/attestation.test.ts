import { describe, expect, it } from 'vitest'
import { decode as cborDecode } from '@atcute/cbor'
import { createAttestationPayload } from '../src'

describe('Attestation Domain', () => {
  describe('createAttestationPayload', () => {
    it('should produce deterministic CBOR with sorted boundaries', () => {
      const payload1 = createAttestationPayload(
        'did:plc:abc123',
        [
          'did:web:nerv.tokyo.jp/leadership',
          'did:web:nerv.tokyo.jp/engineering',
          'did:web:nerv.tokyo.jp/alpha',
        ],
        'did:key:zDnaeTest123',
      )
      const payload2 = createAttestationPayload(
        'did:plc:abc123',
        [
          'did:web:nerv.tokyo.jp/alpha',
          'did:web:nerv.tokyo.jp/engineering',
          'did:web:nerv.tokyo.jp/leadership',
        ],
        'did:key:zDnaeTest123',
      )

      expect(payload1).toEqual(payload2)
    })

    it('should encode boundaries, did, and signingKey fields', () => {
      const payload = createAttestationPayload(
        'did:plc:abc123',
        ['did:web:nerv.tokyo.jp/engineering'],
        'did:key:zDnaeTest123',
      )

      const decoded = cborDecode(payload) as {
        boundaries: string[]
        did: string
        signingKey: string
      }

      expect(decoded.boundaries).toEqual(['did:web:nerv.tokyo.jp/engineering'])
      expect(decoded.did).toBe('did:plc:abc123')
      expect(decoded.signingKey).toBe('did:key:zDnaeTest123')
    })

    it('should produce deterministic key ordering per DAG-CBOR canonical rules', () => {
      const payload = createAttestationPayload(
        'did:plc:abc123',
        ['did:web:nerv.tokyo.jp/beta', 'did:web:nerv.tokyo.jp/alpha'],
        'did:key:zDnaeTest123',
      )

      // DAG-CBOR sorts map keys by byte-length first, then lexicographically
      const decoded = cborDecode(payload) as Record<string, unknown>
      const keys = Object.keys(decoded)
      expect(keys).toEqual(['did', 'boundaries', 'signingKey'])
    })

    it('should handle empty boundaries array', () => {
      const payload = createAttestationPayload(
        'did:plc:abc123',
        [],
        'did:key:zDnaeTest123',
      )

      const decoded = cborDecode(payload) as {
        boundaries: string[]
        did: string
        signingKey: string
      }

      expect(decoded.boundaries).toEqual([])
      expect(decoded.did).toBe('did:plc:abc123')
      expect(decoded.signingKey).toBe('did:key:zDnaeTest123')
    })

    it('should not mutate the input boundaries array', () => {
      const boundaries = [
        'did:web:nerv.tokyo.jp/zebra',
        'did:web:nerv.tokyo.jp/alpha',
        'did:web:nerv.tokyo.jp/middle',
      ]
      createAttestationPayload(
        'did:plc:abc123',
        boundaries,
        'did:key:zDnaeTest123',
      )

      expect(boundaries).toEqual([
        'did:web:nerv.tokyo.jp/zebra',
        'did:web:nerv.tokyo.jp/alpha',
        'did:web:nerv.tokyo.jp/middle',
      ])
    })

    it('should produce different payloads for different inputs', () => {
      const payload1 = createAttestationPayload(
        'did:plc:abc123',
        ['did:web:nerv.tokyo.jp/engineering'],
        'did:key:zDnaeTest123',
      )
      const payload2 = createAttestationPayload(
        'did:plc:xyz789',
        ['did:web:nerv.tokyo.jp/engineering'],
        'did:key:zDnaeTest123',
      )

      expect(payload1).not.toEqual(payload2)
    })
  })
})
