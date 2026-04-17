import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  discoverStratosEnrollment,
  discoverAllStratosEnrollments,
  checkStratosServiceStatus,
  verifyAttestation,
  fetchServerDomains,
  setStratosServiceDid,
  type StratosEnrollment,
} from '../src/lib/stratos'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { Agent } from '@atproto/api'

// Mock @atproto/api
vi.mock('@atproto/api', () => {
  const mockAgent = {
    com: {
      atproto: {
        repo: {
          listRecords: vi.fn(),
          getRecord: vi.fn(),
        },
      },
    },
  }
  return {
    Agent: vi.fn().mockImplementation(function () {
      return mockAgent
    }),
  }
})

// Mock @atproto/crypto
vi.mock('@atproto/crypto', () => {
  return {
    verifySignature: vi.fn(),
  }
})

describe('stratos logic', () => {
  let mockSession: OAuthSession
  let mockAgent: {
    com: {
      atproto: {
        repo: {
          listRecords: unknown
          getRecord: unknown
        }
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSession = {
      sub: 'did:plc:user1',
    } as unknown as OAuthSession
    mockAgent = new Agent(mockSession) as unknown as typeof mockAgent
  })

  describe('discoverStratosEnrollment', () => {
    it('discovers and parses the first enrollment record via listRecords when STRATOS_SERVICE_DID is missing', async () => {
      mockAgent.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [
            {
              uri: 'at://did:plc:user1/zone.stratos.actor.enrollment/1',
              value: {
                service: 'https://stratos.example.com',
                boundaries: [{ value: 'eng' }],
                signingKey: 'key1',
                createdAt: '2024-01-01T12:00:00Z',
              },
            },
          ],
        },
      })

      const enrollment = await discoverStratosEnrollment(mockSession)
      expect(enrollment).not.toBeNull()
      expect(enrollment?.service).toBe('https://stratos.example.com')
      expect(enrollment?.rkey).toBe('1')
      expect(mockAgent.com.atproto.repo.listRecords).toHaveBeenCalled()
    })

    it('discovers enrollment record via getRecord when STRATOS_SERVICE_DID is set', async () => {
      setStratosServiceDid('did:web:test.stratos.actor')

      mockAgent.com.atproto.repo.getRecord.mockResolvedValue({
        data: {
          uri: 'at://did:plc:user1/zone.stratos.actor.enrollment/did:web:test.stratos.actor',
          value: {
            service: 'https://stratos.example.com',
            boundaries: [{ value: 'eng' }],
            signingKey: 'key1',
            createdAt: '2024-01-01T12:00:00Z',
          },
        },
      })

      const enrollment = await discoverStratosEnrollment(mockSession)
      expect(enrollment).not.toBeNull()
      expect(enrollment?.service).toBe('https://stratos.example.com')
      expect(enrollment?.rkey).toBe('did:web:test.stratos.actor')
      expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalledWith({
        repo: 'did:plc:user1',
        collection: 'zone.stratos.actor.enrollment',
        rkey: 'did:web:test.stratos.actor',
      })

      // Reset for other tests
      setStratosServiceDid(undefined)
    })

    it('falls back to listRecords if getRecord fails when STRATOS_SERVICE_DID is set', async () => {
      setStratosServiceDid('did:web:test.stratos.actor')

      mockAgent.com.atproto.repo.getRecord.mockRejectedValue(
        new Error('Not found'),
      )
      mockAgent.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [
            {
              uri: 'at://did:plc:user1/zone.stratos.actor.enrollment/fallback-key',
              value: {
                service: 'https://fallback.example.com',
                boundaries: [],
                signingKey: 'key2',
                createdAt: '2024-01-01T13:00:00Z',
              },
            },
          ],
        },
      })

      const enrollment = await discoverStratosEnrollment(mockSession)
      expect(enrollment).not.toBeNull()
      expect(enrollment?.service).toBe('https://fallback.example.com')
      expect(enrollment?.rkey).toBe('fallback-key')
      expect(mockAgent.com.atproto.repo.getRecord).toHaveBeenCalled()
      expect(mockAgent.com.atproto.repo.listRecords).toHaveBeenCalled()

      setStratosServiceDid(undefined)
    })

    it('returns null if no records found', async () => {
      mockAgent.com.atproto.repo.listRecords.mockResolvedValue({
        data: { records: [] },
      })
      const enrollment = await discoverStratosEnrollment(mockSession)
      expect(enrollment).toBeNull()
    })

    it('returns null on error', async () => {
      mockAgent.com.atproto.repo.listRecords.mockRejectedValue(
        new Error('Fetch failed'),
      )
      const enrollment = await discoverStratosEnrollment(mockSession)
      expect(enrollment).toBeNull()
    })
  })

  describe('discoverAllStratosEnrollments', () => {
    it('discovers all valid enrollment records', async () => {
      mockAgent.com.atproto.repo.listRecords.mockResolvedValue({
        data: {
          records: [
            {
              uri: 'at://did:plc:user1/zone.stratos.actor.enrollment/1',
              value: { service: 'https://s1.com' },
            },
            {
              uri: 'at://did:plc:user1/zone.stratos.actor.enrollment/2',
              value: { service: 'https://s2.com' },
            },
            {
              uri: 'at://did:plc:user1/zone.stratos.actor.enrollment/3',
              value: { invalid: 'record' },
            },
          ],
        },
      })

      const enrollments = await discoverAllStratosEnrollments(mockSession)
      expect(enrollments.length).toBe(2)
      expect(enrollments[0].service).toBe('https://s1.com')
      expect(enrollments[1].service).toBe('https://s2.com')
    })
  })

  describe('checkStratosServiceStatus', () => {
    it('checks status correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ enrolled: true, active: true }),
      })
      global.fetch = mockFetch

      const status = await checkStratosServiceStatus(
        'https://stratos.com',
        'did:plc:user1',
      )
      expect(status.enrolled).toBe(true)
      expect(status.active).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          '/xrpc/zone.stratos.enrollment.status?did=did%3Aplc%3Auser1',
        ),
        expect.any(Object),
      )
    })

    it('returns false if response is not ok', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false })
      const status = await checkStratosServiceStatus(
        'https://stratos.com',
        'did:plc:user1',
      )
      expect(status.enrolled).toBe(false)
    })
  })

  describe('verifyAttestation', () => {
    it('returns false if no attestation', async () => {
      const enrollment: StratosEnrollment = {
        service: 'https://s1.com',
        boundaries: [],
        signingKey: 'k1',
        attestation: null,
        createdAt: '',
        rkey: '1',
      }
      const valid = await verifyAttestation('did:plc:1', enrollment)
      expect(valid).toBe(false)
    })

    it('verifies signature correctly if attestation is present', async () => {
      const { verifySignature } = await import('@atproto/crypto')
      vi.mocked(verifySignature).mockResolvedValue(true)

      const enrollment: StratosEnrollment = {
        service: 'https://s1.com',
        boundaries: [{ value: 'eng' }],
        signingKey: 'k1',
        attestation: {
          sig: new Uint8Array([1, 2, 3]),
          signingKey: 'service-key',
        },
        createdAt: '',
        rkey: '1',
      }
      const valid = await verifyAttestation('did:plc:1', enrollment)
      expect(valid).toBe(true)
      expect(verifySignature).toHaveBeenCalled()
    })
  })

  describe('fetchServerDomains', () => {
    it('fetches domains list', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ domains: ['eng', 'leadership'] }),
      })
      const domains = await fetchServerDomains('https://stratos.com')
      expect(domains).toEqual(['eng', 'leadership'])
    })

    it('returns empty array on error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
      const domains = await fetchServerDomains('https://stratos.com')
      expect(domains).toEqual([])
    })
  })
})
