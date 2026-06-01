import { describe, expect, it, vi } from 'vitest'
import {
  ENROLLMENT_COLLECTION,
  getEnrollmentByServiceDid,
  parseEnrollmentRecord,
  serviceDIDToRkey,
} from '../src/index.js'

// Mock @atcute/client
vi.mock('@atcute/client', async () => {
  const actual = await vi.importActual('@atcute/client')
  return {
    ...actual,
    Client: vi.fn(),
    simpleFetchHandler: vi.fn(),
  }
})

describe('Enrollment Discovery', () => {
  describe('serviceDIDToRkey', () => {
    it('should convert service DID to rkey by replacing percent-encoded colons', () => {
      expect(serviceDIDToRkey('did:web:nerv.tokyo.jp')).toBe(
        'did:web:nerv.tokyo.jp',
      )
      expect(serviceDIDToRkey('did%3Aweb%3Anerv.tokyo.jp')).toBe(
        'did:web:nerv.tokyo.jp',
      )
      expect(serviceDIDToRkey('DID%3aWEB%3aNERV.TOKYO.JP')).toBe(
        'DID:WEB:NERV.TOKYO.JP',
      )
    })
  })

  describe('parseEnrollmentRecord', () => {
    const validRecord = {
      service: 'did:web:nerv.tokyo.jp',
      createdAt: '1995-10-04T18:30:00Z',
      signingKey: 'did:key:zQ3shokFTS3LRDLqSbxDBZ5S4vS34C2Bv6N58K7Y72v4w4',
      boundaries: [{ value: 'geo:tokyo-3' }],
      attestation: {
        signingKey: 'did:key:zQ3shokFTS3LRDLqSbxDBZ5S4vS34C2Bv6N58K7Y72v4w4',
        sig: new Uint8Array([1, 2, 3]),
      },
    }

    it('should parse a valid enrollment record', () => {
      const result = parseEnrollmentRecord(validRecord, 'rkey123')
      expect(result).not.toBeNull()
      expect(result?.service).toBe('did:web:nerv.tokyo.jp')
      expect(result?.rkey).toBe('rkey123')
      expect(result?.attestation.sig).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('should handle $bytes in attestation signature', () => {
      const recordWithBytes = {
        ...validRecord,
        attestation: {
          ...validRecord.attestation,
          sig: { $bytes: 'AQID' }, // base64 for [1, 2, 3]
        },
      }
      const result = parseEnrollmentRecord(recordWithBytes, 'rkey123')
      expect(result?.attestation.sig).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('should return null for invalid records', () => {
      expect(parseEnrollmentRecord(null, 'rkey')).toBeNull()
      expect(parseEnrollmentRecord({}, 'rkey')).toBeNull()
      expect(parseEnrollmentRecord({ service: 123 }, 'rkey')).toBeNull()
      expect(
        parseEnrollmentRecord({ ...validRecord, attestation: null }, 'rkey'),
      ).toBeNull()
    })

    it('should default boundaries to empty array if missing or not an array', () => {
      const recordNoBoundaries = { ...validRecord }
      delete (recordNoBoundaries as any).boundaries
      const result = parseEnrollmentRecord(recordNoBoundaries, 'rkey')
      expect(result?.boundaries).toEqual([])

      const recordInvalidBoundaries = {
        ...validRecord,
        boundaries: 'not-an-array',
      }
      const result2 = parseEnrollmentRecord(recordInvalidBoundaries, 'rkey')
      expect(result2?.boundaries).toEqual([])
    })
  })

  describe('getEnrollmentByServiceDid', () => {
    it('should get a specific enrollment by service DID', async () => {
      const { Client } = await import('@atcute/client')
      const serviceDid = 'did:web:nerv.tokyo.jp'
      const rkey = serviceDIDToRkey(serviceDid)
      const mockGet = vi.fn().mockResolvedValue({
        ok: true,
        data: {
          value: {
            service: serviceDid,
            createdAt: '1995-10-04T18:30:00Z',
            signingKey: 'key1',
            attestation: { signingKey: 'key1', sig: new Uint8Array([1]) },
          },
        },
      })
      ;(Client as any).mockImplementation(function () {
        return { get: mockGet }
      })

      const result = await getEnrollmentByServiceDid(
        'did:plc:shinji',
        'https://pds.nerv',
        serviceDid,
      )
      expect(result).not.toBeNull()
      expect(result?.service).toBe(serviceDid)
      expect(mockGet).toHaveBeenCalledWith('com.atproto.repo.getRecord', {
        params: {
          repo: 'did:plc:shinji',
          collection: ENROLLMENT_COLLECTION,
          rkey,
        },
      })
    })

    it('should return null if record not found', async () => {
      const { Client } = await import('@atcute/client')
      const mockGet = vi.fn().mockResolvedValue({ ok: false })
      ;(Client as any).mockImplementation(function () {
        return { get: mockGet }
      })

      const result = await getEnrollmentByServiceDid(
        'did:plc:rei',
        'https://pds.nerv',
        'did:web:unknown',
      )
      expect(result).toBeNull()
    })

    it('should return null if RPC throws', async () => {
      const { Client } = await import('@atcute/client')
      const mockGet = vi.fn().mockRejectedValue(new Error('Network error'))
      ;(Client as any).mockImplementation(function () {
        return { get: mockGet }
      })

      const result = await getEnrollmentByServiceDid(
        'did:plc:rei',
        'https://pds.nerv',
        'did:web:nerv',
      )
      expect(result).toBeNull()
    })
  })
})
