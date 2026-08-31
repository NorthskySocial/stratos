import { describe, expect, it } from 'vitest'
import {
  classifyCustody,
  ENROLLMENT_MODE,
  EnrollmentConfig,
  extractPdsEndpoint,
  isDidAllowed,
  isPdsAllowed,
  reconcileCustody,
  validateEnrollmentEligibility,
} from '../src/index.js'

describe('Enrollment Domain Logic', () => {
  describe('extractPdsEndpoint', () => {
    it('should extract PDS endpoint from DID document', () => {
      const didDoc = {
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://bsky.social',
          },
        ],
      }

      const result = extractPdsEndpoint(didDoc)
      expect(result).toBe('https://bsky.social')
    })

    it('should return null if no service array', () => {
      const didDoc = {}
      const result = extractPdsEndpoint(didDoc)
      expect(result).toBeNull()
    })

    it('should return null if no PDS service found', () => {
      const didDoc = {
        service: [
          {
            id: '#other',
            type: 'Other',
            serviceEndpoint: 'https://example.com',
          },
        ],
      }

      const result = extractPdsEndpoint(didDoc)
      expect(result).toBeNull()
    })

    it('should handle full service ID with DID prefix', () => {
      const didDoc = {
        service: [
          {
            id: 'did:plc:abc123#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
      }

      const result = extractPdsEndpoint(didDoc)
      expect(result).toBe('https://pds.example.com')
    })
  })

  describe('isDidAllowed', () => {
    it('should allow any DID in open mode', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.OPEN,
        allowedDids: [],
        allowedPdsEndpoints: [],
      }

      expect(isDidAllowed(config, 'did:plc:random')).toBe(true)
    })

    it('should only allowlisted DIDs in allowlist mode', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: ['did:plc:allowed1', 'did:plc:allowed2'],
        allowedPdsEndpoints: [],
      }

      expect(isDidAllowed(config, 'did:plc:allowed1')).toBe(true)
      expect(isDidAllowed(config, 'did:plc:notallowed')).toBe(false)
    })
  })

  describe('isPdsAllowed', () => {
    it('should allow any PDS in open mode', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.OPEN,
        allowedDids: [],
        allowedPdsEndpoints: [],
      }

      expect(isPdsAllowed(config, 'https://any.pds')).toBe(true)
    })

    it('should only allowlisted PDS endpoints in allowlist mode', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: [],
        allowedPdsEndpoints: ['https://bsky.social', 'https://pds.example.com'],
      }

      expect(isPdsAllowed(config, 'https://bsky.social')).toBe(true)
      expect(isPdsAllowed(config, 'https://pds.example.com')).toBe(true)
      expect(isPdsAllowed(config, 'https://other.pds')).toBe(false)
    })

    it('should normalize trailing slashes', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: [],
        allowedPdsEndpoints: ['https://bsky.social/'],
      }

      expect(isPdsAllowed(config, 'https://bsky.social')).toBe(true)
    })
  })

  describe('validateEnrollmentEligibility', () => {
    it('should allow enrollment in open mode', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.OPEN,
        allowedDids: [],
        allowedPdsEndpoints: [],
      }

      const result = validateEnrollmentEligibility(
        config,
        'did:plc:test',
        'https://bsky.social',
      )

      expect(result.allowed).toBe(true)
      expect(result.pdsEndpoint).toBe('https://bsky.social')
    })

    it('should allow in open mode even without PDS endpoint', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.OPEN,
        allowedDids: [],
        allowedPdsEndpoints: [],
      }

      const result = validateEnrollmentEligibility(config, 'did:plc:test', null)

      expect(result.allowed).toBe(true)
      expect(result.pdsEndpoint).toBeUndefined()
    })

    it('should allow DID in allowlist', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: ['did:plc:allowed'],
        allowedPdsEndpoints: [],
      }

      const result = validateEnrollmentEligibility(
        config,
        'did:plc:allowed',
        'https://bsky.social',
      )

      expect(result.allowed).toBe(true)
    })

    it('should allow PDS endpoint in allowlist', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: [],
        allowedPdsEndpoints: ['https://bsky.social'],
      }

      const result = validateEnrollmentEligibility(
        config,
        'did:plc:random',
        'https://bsky.social',
      )

      expect(result.allowed).toBe(true)
    })

    it('should deny if neither DID nor PDS is in allowlist', () => {
      const config: EnrollmentConfig = {
        mode: ENROLLMENT_MODE.ALLOWLIST,
        allowedDids: ['did:plc:other'],
        allowedPdsEndpoints: ['https://other.pds'],
      }

      const result = validateEnrollmentEligibility(
        config,
        'did:plc:test',
        'https://bsky.social',
      )

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('NotInAllowlist')
    })
  })

  describe('classifyCustody', () => {
    it('grants pds custody only on a confirmed capable verdict', () => {
      expect(classifyCustody('capable')).toBe('pds')
    })

    it('falls back to stratos custody on a not-capable verdict', () => {
      expect(classifyCustody('not-capable')).toBe('stratos')
    })

    it('does not select custody on an unknown verdict', () => {
      expect(classifyCustody('unknown')).toBeUndefined()
    })

    it('does not select custody when no verdict was recorded', () => {
      expect(classifyCustody(undefined)).toBeUndefined()
    })
  })

  describe('reconcileCustody', () => {
    it('upgrades stratos custody to pds on a confirmed capable verdict', () => {
      expect(reconcileCustody('stratos', 'capable')).toBe('pds')
    })

    it('withdraws pds custody to stratos on a confirmed not-capable verdict', () => {
      expect(reconcileCustody('pds', 'not-capable')).toBe('stratos')
    })

    it('leaves pds custody unchanged on an unknown verdict', () => {
      // Losing the answer is not the same as learning the answer is no.
      // This is the whole reason the third state exists.
      expect(reconcileCustody('pds', 'unknown')).toBe('pds')
    })

    it('leaves stratos custody unchanged on an unknown verdict', () => {
      expect(reconcileCustody('stratos', 'unknown')).toBe('stratos')
    })

    it('leaves custody unchanged when no verdict was recorded', () => {
      expect(reconcileCustody('pds', undefined)).toBe('pds')
      expect(reconcileCustody('stratos', undefined)).toBe('stratos')
    })
  })
})
