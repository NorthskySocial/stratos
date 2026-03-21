import { describe, it, expect, vi } from 'vitest'
import { EnrollmentServiceImpl } from '../src/features/enrollment/adapter.js'
import type { EnrollmentStore } from '../src/oauth/routes.js'

function createMockStore(
  overrides: Partial<EnrollmentStore> = {},
): EnrollmentStore {
  return {
    isEnrolled: vi.fn(async () => false),
    getEnrollment: vi.fn(async () => null),
    enroll: vi.fn(async () => {}),
    unenroll: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    getBoundaries: vi.fn(async () => []),
    ...overrides,
  }
}

describe('EnrollmentServiceImpl', () => {
  describe('getEnrollment', () => {
    it('should return null when user is not enrolled', async () => {
      const store = createMockStore()
      const service = new EnrollmentServiceImpl(store, vi.fn())

      const result = await service.getEnrollment('did:plc:setsuna')
      expect(result).toBeNull()
    })

    it('should return enrollment with boundaries from store', async () => {
      const store = createMockStore({
        getEnrollment: vi.fn(async () => ({
          did: 'did:plc:setsuna',
          enrolledAt: '2026-01-01T00:00:00.000Z',
          pdsEndpoint: 'https://pds.example.com',
          signingKeyDid: 'did:key:zSailorPluto',
          active: true,
          enrollmentRkey: 'rkey123',
        })),
        getBoundaries: vi.fn(async () => ['posters-madness', 'bees']),
      })
      const service = new EnrollmentServiceImpl(store, vi.fn())

      const result = await service.getEnrollment('did:plc:setsuna')

      expect(result).not.toBeNull()
      expect(result!.did).toBe('did:plc:setsuna')
      expect(result!.boundaries).toEqual(['posters-madness', 'bees'])
      expect(result!.enrolledAt).toBeInstanceOf(Date)
      expect(result!.active).toBe(true)
      expect(result!.enrollmentRkey).toBe('rkey123')
    })

    it('should return empty boundaries when user has none', async () => {
      const store = createMockStore({
        getEnrollment: vi.fn(async () => ({
          did: 'did:plc:hotaru',
          enrolledAt: '2026-03-01T00:00:00.000Z',
          signingKeyDid: 'did:key:zSailorSaturn',
          active: true,
        })),
        getBoundaries: vi.fn(async () => []),
      })
      const service = new EnrollmentServiceImpl(store, vi.fn())

      const result = await service.getEnrollment('did:plc:hotaru')

      expect(result).not.toBeNull()
      expect(result!.boundaries).toEqual([])
    })
  })
})
