import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { EnrollmentStoreWriter } from '@northskysocial/stratos-core'
import { EnrollmentServiceImpl } from '../src/features/enrollment/adapter.js'

/** Only the methods this adapter calls. */
type MockEnrollmentStore = {
  [K in
    | 'isEnrolled'
    | 'enroll'
    | 'getEnrollment'
    | 'getBoundaries'
    | 'unenroll']: Mock
}

describe('EnrollmentServiceImpl', () => {
  let mockEnrollmentStore: MockEnrollmentStore
  let actorStoreCreator: Mock<(did: string) => Promise<void>>
  let actorStoreDestroyer: Mock<(did: string) => Promise<void>>

  const did = 'did:plc:motoko'

  beforeEach(() => {
    mockEnrollmentStore = {
      isEnrolled: vi.fn(),
      enroll: vi.fn().mockResolvedValue(undefined),
      getEnrollment: vi.fn().mockResolvedValue(null),
      getBoundaries: vi.fn().mockResolvedValue([]),
      unenroll: vi.fn(),
    }
    actorStoreCreator = vi.fn().mockResolvedValue(undefined)
    actorStoreDestroyer = vi.fn().mockResolvedValue(undefined)
  })

  describe('enroll (saveEnrollment)', () => {
    it('defaults custody, repoHost, and pdsEndpoint for a genuinely new enrollment', async () => {
      mockEnrollmentStore.getEnrollment.mockResolvedValue(null)

      const service = new EnrollmentServiceImpl(
        mockEnrollmentStore as unknown as EnrollmentStoreWriter,
        actorStoreCreator,
        actorStoreDestroyer,
      )

      const result = await service.enroll(did, ['section9'], 'did:key:zMotoko')

      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({
          did,
          pdsEndpoint: undefined,
          custody: undefined,
          repoHost: undefined,
          capabilityVerdict: undefined,
        }),
      )
      // The returned Enrollment must match the row just written, not a
      // stripped-down object that contradicts it.
      expect(result.custody).toBeUndefined()
      expect(result.repoHost).toBeUndefined()
    })

    it('carries forward an existing enrollment custody, repoHost, and pdsEndpoint', async () => {
      // A caller re-invoking enroll() for an already-enrolled 'pds'-custody
      // user must not silently reset them back to 'stratos' custody --
      // enroll() is a full-replace upsert, so this adapter must read first.
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did,
        enrolledAt: '2026-01-01T00:00:00.000Z',
        pdsEndpoint: 'https://niihama.example.com',
        signingKeyDid: 'did:key:zOldKey',
        active: true,
        custody: 'pds',
        repoHost: 'https://niihama.example.com',
        capabilityVerdict: 'capable',
      })

      const service = new EnrollmentServiceImpl(
        mockEnrollmentStore as unknown as EnrollmentStoreWriter,
        actorStoreCreator,
        actorStoreDestroyer,
      )

      const result = await service.enroll(did, ['section9'], 'did:key:zMotoko')

      expect(mockEnrollmentStore.enroll).toHaveBeenCalledWith(
        expect.objectContaining({
          did,
          pdsEndpoint: 'https://niihama.example.com',
          custody: 'pds',
          repoHost: 'https://niihama.example.com',
          capabilityVerdict: 'capable',
        }),
      )
      // The returned Enrollment must match the row just written, not a
      // stripped-down object that contradicts it.
      expect(result.custody).toBe('pds')
      expect(result.repoHost).toBe('https://niihama.example.com')
    })
  })

  describe('getEnrollment', () => {
    it('returns null when no record is stored', async () => {
      mockEnrollmentStore.getEnrollment.mockResolvedValue(null)

      const service = new EnrollmentServiceImpl(
        mockEnrollmentStore as unknown as EnrollmentStoreWriter,
        actorStoreCreator,
        actorStoreDestroyer,
      )

      expect(await service.getEnrollment(did)).toBeNull()
    })

    it('maps custody and repoHost onto the domain Enrollment', async () => {
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did,
        enrolledAt: '2026-01-01T00:00:00.000Z',
        pdsEndpoint: 'https://niihama.example.com',
        signingKeyDid: 'did:key:zOldKey',
        active: true,
        custody: 'pds',
        repoHost: 'https://niihama.example.com',
      })
      mockEnrollmentStore.getBoundaries.mockResolvedValue(['section9'])

      const service = new EnrollmentServiceImpl(
        mockEnrollmentStore as unknown as EnrollmentStoreWriter,
        actorStoreCreator,
        actorStoreDestroyer,
      )

      const result = await service.getEnrollment(did)

      expect(result?.custody).toBe('pds')
      expect(result?.repoHost).toBe('https://niihama.example.com')
    })

    it('leaves custody and repoHost undefined for a stratos-custody enrollment', async () => {
      mockEnrollmentStore.getEnrollment.mockResolvedValue({
        did,
        enrolledAt: '2026-01-01T00:00:00.000Z',
        signingKeyDid: 'did:key:zOldKey',
        active: true,
      })
      mockEnrollmentStore.getBoundaries.mockResolvedValue([])

      const service = new EnrollmentServiceImpl(
        mockEnrollmentStore as unknown as EnrollmentStoreWriter,
        actorStoreCreator,
        actorStoreDestroyer,
      )

      const result = await service.getEnrollment(did)

      expect(result?.custody).toBeUndefined()
      expect(result?.repoHost).toBeUndefined()
    })
  })
})
