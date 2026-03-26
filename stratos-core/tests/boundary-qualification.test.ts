import { describe, it, expect } from 'vitest'
import {
  qualifyBoundary,
  qualifyBoundaries,
  isQualifiedBoundary,
  parseQualifiedBoundary,
  assertBoundaryMatchesService,
  ensureQualifiedBoundaries,
  BoundaryServiceMismatchError,
} from '../src/validation/boundary-qualification.js'

const NERV_SERVICE = 'did:web:nerv.tokyo.jp'
const SEELE_SERVICE = 'did:web:seele.berlin.de'

describe('boundary qualification', () => {
  describe('qualifyBoundary', () => {
    it('qualifies a bare name with the service DID', () => {
      expect(qualifyBoundary(NERV_SERVICE, 'evangelion')).toBe(
        'did:web:nerv.tokyo.jp/evangelion',
      )
    })

    it('handles did:plc identifiers', () => {
      expect(qualifyBoundary('did:plc:shinji123', 'unit01')).toBe(
        'did:plc:shinji123/unit01',
      )
    })
  })

  describe('qualifyBoundaries', () => {
    it('qualifies multiple names', () => {
      const result = qualifyBoundaries(NERV_SERVICE, [
        'evangelion',
        'angel-research',
        'magi',
      ])
      expect(result).toEqual([
        'did:web:nerv.tokyo.jp/evangelion',
        'did:web:nerv.tokyo.jp/angel-research',
        'did:web:nerv.tokyo.jp/magi',
      ])
    })

    it('returns empty array for empty input', () => {
      expect(qualifyBoundaries(NERV_SERVICE, [])).toEqual([])
    })
  })

  describe('isQualifiedBoundary', () => {
    it('returns true for qualified boundaries', () => {
      expect(isQualifiedBoundary('did:web:nerv.tokyo.jp/evangelion')).toBe(true)
      expect(isQualifiedBoundary('did:plc:abc123/magi')).toBe(true)
    })

    it('returns false for bare names', () => {
      expect(isQualifiedBoundary('evangelion')).toBe(false)
      expect(isQualifiedBoundary('angel-research')).toBe(false)
    })

    it('returns false for strings that start with did: but have no separator', () => {
      expect(isQualifiedBoundary('did:web:nerv.tokyo.jp')).toBe(false)
    })
  })

  describe('parseQualifiedBoundary', () => {
    it('parses a qualified boundary into DID and name', () => {
      const result = parseQualifiedBoundary('did:web:nerv.tokyo.jp/evangelion')
      expect(result).toEqual({
        serviceDid: 'did:web:nerv.tokyo.jp',
        name: 'evangelion',
      })
    })

    it('parses did:plc boundaries', () => {
      const result = parseQualifiedBoundary('did:plc:shinji123/unit01')
      expect(result).toEqual({
        serviceDid: 'did:plc:shinji123',
        name: 'unit01',
      })
    })

    it('returns null for bare names', () => {
      expect(parseQualifiedBoundary('evangelion')).toBeNull()
    })

    it('returns null for unqualified did strings', () => {
      expect(parseQualifiedBoundary('did:web:nerv.tokyo.jp')).toBeNull()
    })
  })

  describe('assertBoundaryMatchesService', () => {
    it('does not throw for matching service DID', () => {
      expect(() =>
        assertBoundaryMatchesService(
          'did:web:nerv.tokyo.jp/evangelion',
          NERV_SERVICE,
        ),
      ).not.toThrow()
    })

    it('throws BoundaryServiceMismatchError for wrong service DID', () => {
      expect(() =>
        assertBoundaryMatchesService(
          'did:web:seele.berlin.de/instrumentality',
          NERV_SERVICE,
        ),
      ).toThrow(BoundaryServiceMismatchError)
    })

    it('includes the expected and actual service DIDs in the error', () => {
      try {
        assertBoundaryMatchesService(
          'did:web:seele.berlin.de/instrumentality',
          NERV_SERVICE,
        )
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(BoundaryServiceMismatchError)
        const mismatch = err as BoundaryServiceMismatchError
        expect(mismatch.expectedServiceDid).toBe(NERV_SERVICE)
        expect(mismatch.actualServiceDid).toBe(SEELE_SERVICE)
        expect(mismatch.boundary).toBe('did:web:seele.berlin.de/instrumentality')
      }
    })

    it('throws for unqualified boundaries', () => {
      expect(() =>
        assertBoundaryMatchesService('evangelion', NERV_SERVICE),
      ).toThrow(BoundaryServiceMismatchError)
    })
  })

  describe('ensureQualifiedBoundaries', () => {
    it('qualifies bare names', () => {
      const result = ensureQualifiedBoundaries(NERV_SERVICE, [
        'evangelion',
        'magi',
      ])
      expect(result).toEqual([
        'did:web:nerv.tokyo.jp/evangelion',
        'did:web:nerv.tokyo.jp/magi',
      ])
    })

    it('passes through already-qualified boundaries for the same service', () => {
      const result = ensureQualifiedBoundaries(NERV_SERVICE, [
        'did:web:nerv.tokyo.jp/evangelion',
      ])
      expect(result).toEqual(['did:web:nerv.tokyo.jp/evangelion'])
    })

    it('handles mixed bare and qualified boundaries', () => {
      const result = ensureQualifiedBoundaries(NERV_SERVICE, [
        'did:web:nerv.tokyo.jp/evangelion',
        'magi',
      ])
      expect(result).toEqual([
        'did:web:nerv.tokyo.jp/evangelion',
        'did:web:nerv.tokyo.jp/magi',
      ])
    })

    it('throws for qualified boundaries from a different service', () => {
      expect(() =>
        ensureQualifiedBoundaries(NERV_SERVICE, [
          'did:web:seele.berlin.de/instrumentality',
        ]),
      ).toThrow(BoundaryServiceMismatchError)
    })
  })
})
