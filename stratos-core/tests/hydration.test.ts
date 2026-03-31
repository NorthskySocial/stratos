/**
 * Unit tests for hydration module domain logic
 */
import { describe, expect, it } from 'vitest'
import type { AccessCheckInput, HydrationContext } from '../src/index.js'
import {
  canAccessRecord,
  createHydrationContext,
  filterAccessibleRecords,
  hasIntersection,
  isLocalService,
  parseServiceEndpoint,
} from '../src/index.js'

describe('Hydration Domain', () => {
  describe('canAccessRecord', () => {
    it('should grant access when viewer is the owner', () => {
      const input: AccessCheckInput = {
        recordBoundaries: ['secret.example.com'],
        ownerDid: 'did:plc:owner123',
        context: {
          viewerDid: 'did:plc:owner123',
          viewerDomains: [],
        },
      }

      expect(canAccessRecord(input)).toBe(true)
    })

    it('should deny access for unauthenticated viewer', () => {
      const input: AccessCheckInput = {
        recordBoundaries: ['example.com'],
        ownerDid: 'did:plc:owner123',
        context: {
          viewerDid: null,
          viewerDomains: [],
        },
      }

      expect(canAccessRecord(input)).toBe(false)
    })

    it('should grant access when record has no boundaries (public to enrolled)', () => {
      const input: AccessCheckInput = {
        recordBoundaries: [],
        ownerDid: 'did:plc:owner123',
        context: {
          viewerDid: 'did:plc:viewer456',
          viewerDomains: [],
        },
      }

      expect(canAccessRecord(input)).toBe(true)
    })

    it('should grant access when viewer shares a boundary with record', () => {
      const input: AccessCheckInput = {
        recordBoundaries: ['engineering.example.com', 'leadership.example.com'],
        ownerDid: 'did:plc:owner123',
        context: {
          viewerDid: 'did:plc:viewer456',
          viewerDomains: ['engineering.example.com'],
        },
      }

      expect(canAccessRecord(input)).toBe(true)
    })

    it('should deny access when viewer has no matching boundaries', () => {
      const input: AccessCheckInput = {
        recordBoundaries: ['leadership.example.com'],
        ownerDid: 'did:plc:owner123',
        context: {
          viewerDid: 'did:plc:viewer456',
          viewerDomains: ['engineering.example.com', 'sales.example.com'],
        },
      }

      expect(canAccessRecord(input)).toBe(false)
    })
  })

  describe('hasIntersection', () => {
    it('should return false for empty arrays', () => {
      expect(hasIntersection([], [])).toBe(false)
      expect(hasIntersection(['a', 'b'], [])).toBe(false)
      expect(hasIntersection([], ['a', 'b'])).toBe(false)
    })

    it('should detect intersection and non-intersection', () => {
      expect(hasIntersection(['a'], ['a'])).toBe(true)
      expect(hasIntersection(['a'], ['b'])).toBe(false)
      expect(hasIntersection(['a', 'b', 'c'], ['c', 'd', 'e'])).toBe(true)
      expect(hasIntersection(['a', 'b'], ['c', 'd'])).toBe(false)
    })
  })

  describe('filterAccessibleRecords', () => {
    it('should filter records based on viewer access', () => {
      const records = [
        {
          uri: 'at://did:plc:a/post/1',
          boundaries: ['team-a.example.com'],
          ownerDid: 'did:plc:a',
        },
        {
          uri: 'at://did:plc:b/post/2',
          boundaries: ['team-b.example.com'],
          ownerDid: 'did:plc:b',
        },
        { uri: 'at://did:plc:c/post/3', boundaries: [], ownerDid: 'did:plc:c' },
      ]

      const context: HydrationContext = {
        viewerDid: 'did:plc:viewer',
        viewerDomains: ['team-a.example.com'],
      }

      const accessible = filterAccessibleRecords(records, context)

      expect(accessible).toHaveLength(2)
      expect(accessible[0].uri).toBe('at://did:plc:a/post/1')
      expect(accessible[1].uri).toBe('at://did:plc:c/post/3')
    })

    it('should include records owned by viewer regardless of boundaries', () => {
      const records = [
        {
          uri: 'at://did:plc:viewer/post/1',
          boundaries: ['secret.example.com'],
          ownerDid: 'did:plc:viewer',
        },
      ]

      const context: HydrationContext = {
        viewerDid: 'did:plc:viewer',
        viewerDomains: [],
      }

      const accessible = filterAccessibleRecords(records, context)

      expect(accessible).toHaveLength(1)
    })

    it('should return empty array for unauthenticated viewer', () => {
      const records = [
        {
          uri: 'at://did:plc:a/post/1',
          boundaries: ['team.example.com'],
          ownerDid: 'did:plc:a',
        },
      ]

      const context: HydrationContext = {
        viewerDid: null,
        viewerDomains: [],
      }

      const accessible = filterAccessibleRecords(records, context)

      expect(accessible).toHaveLength(0)
    })
  })

  describe('parseServiceEndpoint', () => {
    it('should convert https URL to did:web format', () => {
      expect(parseServiceEndpoint('https://stratos.example.com')).toBe(
        'did:web:stratos.example.com',
      )
    })

    it('should handle URLs with ports', () => {
      expect(parseServiceEndpoint('http://localhost:3000')).toBe(
        'did:web:localhost',
      )
    })

    it('should return null for invalid URLs', () => {
      expect(parseServiceEndpoint('not-a-url')).toBe(null)
      expect(parseServiceEndpoint('')).toBe(null)
    })
  })

  describe('isLocalService', () => {
    it('should return true when service DIDs match', () => {
      expect(
        isLocalService(
          'did:web:stratos.example.com#atproto_pns',
          'did:web:stratos.example.com#atproto_pns',
        ),
      ).toBe(true)
    })

    it('should return false when service DIDs differ', () => {
      expect(
        isLocalService(
          'did:web:other.example.com#atproto_pns',
          'did:web:stratos.example.com#atproto_pns',
        ),
      ).toBe(false)
    })
  })

  describe('createHydrationContext', () => {
    it('should create context with viewer info', () => {
      const context = createHydrationContext('did:plc:viewer123', [
        'team.example.com',
      ])

      expect(context.viewerDid).toBe('did:plc:viewer123')
      expect(context.viewerDomains).toEqual(['team.example.com'])
    })

    it('should create context for unauthenticated viewer', () => {
      const context = createHydrationContext(null, [])

      expect(context.viewerDid).toBe(null)
      expect(context.viewerDomains).toEqual([])
    })
  })
})
