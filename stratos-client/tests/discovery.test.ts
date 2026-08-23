import { describe, expect, it, vi } from 'vitest'
import {
  ENROLLMENT_COLLECTION,
  discoverEnrollments,
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

    it('should return null (not throw) for malformed base64 $bytes', () => {
      const record = {
        ...validRecord,
        attestation: {
          ...validRecord.attestation,
          sig: { $bytes: '!!!not-base64!!!' },
        },
      }
      expect(() => parseEnrollmentRecord(record, 'rkey')).not.toThrow()
      expect(parseEnrollmentRecord(record, 'rkey')).toBeNull()
    })

    it('should return null for non-string $bytes', () => {
      const record = {
        ...validRecord,
        attestation: {
          ...validRecord.attestation,
          sig: { $bytes: null },
        },
      }
      expect(parseEnrollmentRecord(record, 'rkey')).toBeNull()
    })

    it('should filter out malformed boundaries elements', () => {
      const record = {
        ...validRecord,
        boundaries: ['plain-string', null, { value: 'geo:tokyo-3' }],
      }
      const result = parseEnrollmentRecord(record, 'rkey')
      expect(result?.boundaries).toEqual([{ value: 'geo:tokyo-3' }])
    })
  })

  describe('discoverEnrollments', () => {
    const enrollmentRecord = (serviceDid: string) => ({
      uri: `at://did:plc:shinji/${ENROLLMENT_COLLECTION}/${serviceDid}`,
      value: {
        service: serviceDid,
        createdAt: '1995-10-04T18:30:00Z',
        signingKey: 'did:key:zAsukaKey',
        attestation: {
          signingKey: 'did:key:zMisatoKey',
          sig: new Uint8Array([1, 2, 3]),
        },
      },
    })

    const mockClient = async (mockGet: ReturnType<typeof vi.fn>) => {
      const { Client } = await import('@atcute/client')
      ;(Client as any).mockImplementation(function () {
        return { get: mockGet }
      })
    }

    it('should follow the cursor across pages and return all enrollments', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          data: {
            records: [enrollmentRecord('did:web:nerv.tokyo.jp')],
            cursor: 'magi-1',
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: {
            records: [enrollmentRecord('did:web:seele.berlin.de')],
          },
        })
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:shinji',
        'https://pds.nerv',
      )

      expect(result).toHaveLength(2)
      expect(result.map((e) => e.rkey)).toEqual([
        'did:web:nerv.tokyo.jp',
        'did:web:seele.berlin.de',
      ])
      expect(mockGet).toHaveBeenCalledTimes(2)
      expect(mockGet.mock.calls[0][1].params).toMatchObject({
        repo: 'did:plc:shinji',
        collection: ENROLLMENT_COLLECTION,
        limit: 100,
      })
      expect(mockGet.mock.calls[0][1].params).not.toHaveProperty('cursor')
      expect(mockGet.mock.calls[1][1].params).toMatchObject({
        cursor: 'magi-1',
      })
    })

    it('should make a single request when the response has no cursor', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        ok: true,
        data: { records: [enrollmentRecord('did:web:nerv.tokyo.jp')] },
      })
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:rei',
        'https://pds.nerv',
      )

      expect(result).toHaveLength(1)
      expect(mockGet).toHaveBeenCalledTimes(1)
    })

    it('should terminate when the server repeats a cursor', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        ok: true,
        data: {
          records: [enrollmentRecord('did:web:nerv.tokyo.jp')],
          cursor: 'magi-loop',
        },
      })
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:asuka',
        'https://pds.nerv',
      )

      expect(mockGet).toHaveBeenCalledTimes(2)
      expect(result).toHaveLength(2)
    })

    it('should stop when a page carries a cursor but no records', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        ok: true,
        data: { records: [], cursor: 'magi-1' },
      })
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:misato',
        'https://pds.nerv',
      )

      expect(result).toEqual([])
      expect(mockGet).toHaveBeenCalledTimes(1)
    })

    it('should return an empty array when a later page request throws', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          data: {
            records: [enrollmentRecord('did:web:nerv.tokyo.jp')],
            cursor: 'magi-1',
          },
        })
        .mockRejectedValueOnce(new Error('Network error'))
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:shinji',
        'https://pds.nerv',
      )

      expect(result).toEqual([])
    })

    it('should return an empty array when a page response is not ok', async () => {
      const mockGet = vi.fn().mockResolvedValue({ ok: false })
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:rei',
        'https://pds.nerv',
      )

      expect(result).toEqual([])
    })

    it('should filter invalid records on later pages', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          data: {
            records: [enrollmentRecord('did:web:nerv.tokyo.jp')],
            cursor: 'magi-1',
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: {
            records: [
              {
                uri: `at://did:plc:shinji/${ENROLLMENT_COLLECTION}/bad`,
                value: { service: 42 },
              },
              enrollmentRecord('did:web:seele.berlin.de'),
            ],
          },
        })
      await mockClient(mockGet)

      const result = await discoverEnrollments(
        'did:plc:shinji',
        'https://pds.nerv',
      )

      expect(result).toHaveLength(2)
      expect(result.map((e) => e.rkey)).toEqual([
        'did:web:nerv.tokyo.jp',
        'did:web:seele.berlin.de',
      ])
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
