import { describe, it, expect, vi } from 'vitest'
import {
  validateEnrollment,
  assertEnrollment,
  extractPdsEndpoint,
  EnrollmentConfig,
  EnrollmentDeniedError,
} from '../src/auth'
import type { IdResolver, DidDocument } from '@atproto/identity'

// Mock IdResolver
function createMockIdResolver(didDoc: DidDocument | null): IdResolver {
  return {
    did: {
      resolve: vi.fn().mockResolvedValue(didDoc),
    },
  } as unknown as IdResolver
}

describe('enrollment', () => {
  describe('extractPdsEndpoint', () => {
    it('should extract PDS endpoint from did document', () => {
      const didDoc: DidDocument = {
        id: 'did:plc:test',
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
      }

      expect(extractPdsEndpoint(didDoc)).toBe('https://pds.example.com')
    })

    it('should extract PDS with full id format', () => {
      const didDoc: DidDocument = {
        id: 'did:plc:test',
        service: [
          {
            id: 'did:plc:test#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
      }

      expect(extractPdsEndpoint(didDoc)).toBe('https://pds.example.com')
    })

    it('should return null if no service array', () => {
      const didDoc: DidDocument = {
        id: 'did:plc:test',
      }

      expect(extractPdsEndpoint(didDoc)).toBeNull()
    })

    it('should return null if no PDS service found', () => {
      const didDoc: DidDocument = {
        id: 'did:plc:test',
        service: [
          {
            id: '#other_service',
            type: 'OtherService',
            serviceEndpoint: 'https://other.example.com',
          },
        ],
      }

      expect(extractPdsEndpoint(didDoc)).toBeNull()
    })

    it('should return null for non-string endpoint', () => {
      const didDoc = {
        id: 'did:plc:test',
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: ['https://pds.example.com'],
          },
        ],
      } as unknown

      expect(extractPdsEndpoint(didDoc as DidDocument)).toBeNull()
    })
  })

  describe('validateEnrollment', () => {
    const did = 'did:plc:testuser'

    describe('open mode', () => {
      const openConfig: EnrollmentConfig = {
        mode: 'open',
        allowedDids: [],
        allowedPdsEndpoints: [],
      }

      it('should allow any user in open mode', async () => {
        const mockResolver = createMockIdResolver(null)

        const result = await validateEnrollment(openConfig, did, mockResolver)

        expect(result.allowed).toBe(true)
        expect(result.reason).toBeUndefined()
      })
    })

    describe('allowlist mode - DID list', () => {
      const allowedDid = 'did:plc:allowed'
      const didListConfig: EnrollmentConfig = {
        mode: 'allowlist',
        allowedDids: [allowedDid, 'did:plc:other-allowed'],
        allowedPdsEndpoints: [],
      }

      it('should allow DID in allowlist', async () => {
        const mockResolver = createMockIdResolver(null)

        const result = await validateEnrollment(
          didListConfig,
          allowedDid,
          mockResolver,
        )

        expect(result.allowed).toBe(true)
      })

      it('should deny DID not in allowlist', async () => {
        const mockResolver = createMockIdResolver(null)

        const result = await validateEnrollment(
          didListConfig,
          'did:plc:notallowed',
          mockResolver,
        )

        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('NotInAllowlist')
      })
    })

    describe('allowlist mode - PDS endpoint list', () => {
      const pdsConfig: EnrollmentConfig = {
        mode: 'allowlist',
        allowedDids: [],
        allowedPdsEndpoints: [
          'https://pds.company.com',
          'https://pds.partner.com/',
        ],
      }

      it('should allow user from allowed PDS', async () => {
        const didDoc: DidDocument = {
          id: did,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.company.com',
            },
          ],
        }
        const mockResolver = createMockIdResolver(didDoc)

        const result = await validateEnrollment(pdsConfig, did, mockResolver)

        expect(result.allowed).toBe(true)
        expect(result.pdsEndpoint).toBe('https://pds.company.com')
      })

      it('should normalize trailing slashes in PDS endpoints', async () => {
        const didDoc: DidDocument = {
          id: did,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.partner.com', // no trailing slash
            },
          ],
        }
        const mockResolver = createMockIdResolver(didDoc)

        const result = await validateEnrollment(pdsConfig, did, mockResolver)

        expect(result.allowed).toBe(true)
      })

      it('should deny user from disallowed PDS', async () => {
        const didDoc: DidDocument = {
          id: did,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.other.com',
            },
          ],
        }
        const mockResolver = createMockIdResolver(didDoc)

        const result = await validateEnrollment(pdsConfig, did, mockResolver)

        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('NotInAllowlist')
      })

      it('should return DidNotResolved when DID cannot be resolved', async () => {
        const mockResolver = createMockIdResolver(null)

        const result = await validateEnrollment(pdsConfig, did, mockResolver)

        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('DidNotResolved')
      })

      it('should return PdsEndpointNotFound when DID has no PDS', async () => {
        const didDoc: DidDocument = {
          id: did,
          service: [],
        }
        const mockResolver = createMockIdResolver(didDoc)

        const result = await validateEnrollment(pdsConfig, did, mockResolver)

        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('PdsEndpointNotFound')
      })

      it('should return DidNotResolved on resolution error', async () => {
        const mockResolver = {
          did: {
            resolve: vi.fn().mockRejectedValue(new Error('Network error')),
          },
        } as unknown as IdResolver

        const result = await validateEnrollment(pdsConfig, did, mockResolver)

        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('DidNotResolved')
      })
    })

    describe('allowlist mode - combined DID and PDS', () => {
      const combinedConfig: EnrollmentConfig = {
        mode: 'allowlist',
        allowedDids: ['did:plc:vip-user'],
        allowedPdsEndpoints: ['https://pds.company.com'],
      }

      it('should allow VIP user regardless of PDS', async () => {
        const mockResolver = createMockIdResolver(null) // No resolution needed

        const result = await validateEnrollment(
          combinedConfig,
          'did:plc:vip-user',
          mockResolver,
        )

        expect(result.allowed).toBe(true)
        // DID check happens first, so resolver shouldn't be called
        expect(mockResolver.did.resolve).not.toHaveBeenCalled()
      })

      it('should allow non-VIP user from allowed PDS', async () => {
        const didDoc: DidDocument = {
          id: 'did:plc:regular-user',
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.company.com',
            },
          ],
        }
        const mockResolver = createMockIdResolver(didDoc)

        const result = await validateEnrollment(
          combinedConfig,
          'did:plc:regular-user',
          mockResolver,
        )

        expect(result.allowed).toBe(true)
      })

      it('should deny non-VIP user from non-allowed PDS', async () => {
        const didDoc: DidDocument = {
          id: 'did:plc:outsider',
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://bsky.social',
            },
          ],
        }
        const mockResolver = createMockIdResolver(didDoc)

        const result = await validateEnrollment(
          combinedConfig,
          'did:plc:outsider',
          mockResolver,
        )

        expect(result.allowed).toBe(false)
        expect(result.reason).toBe('NotInAllowlist')
      })
    })
  })

  describe('assertEnrollment', () => {
    it('should return pdsEndpoint when allowed', async () => {
      const config: EnrollmentConfig = {
        mode: 'allowlist',
        allowedDids: [],
        allowedPdsEndpoints: ['https://pds.example.com'],
      }

      const didDoc: DidDocument = {
        id: 'did:plc:test',
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
      }
      const mockResolver = createMockIdResolver(didDoc)

      const result = await assertEnrollment(
        config,
        'did:plc:test',
        mockResolver,
      )

      expect(result.pdsEndpoint).toBe('https://pds.example.com')
    })

    it('should throw EnrollmentDeniedError when not allowed', async () => {
      const config: EnrollmentConfig = {
        mode: 'allowlist',
        allowedDids: [],
        allowedPdsEndpoints: ['https://pds.example.com'],
      }

      const didDoc: DidDocument = {
        id: 'did:plc:test',
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://other.pds.com',
          },
        ],
      }
      const mockResolver = createMockIdResolver(didDoc)

      await expect(
        assertEnrollment(config, 'did:plc:test', mockResolver),
      ).rejects.toThrow(EnrollmentDeniedError)
    })

    it('should include reason in EnrollmentDeniedError', async () => {
      const config: EnrollmentConfig = {
        mode: 'allowlist',
        allowedDids: [],
        allowedPdsEndpoints: ['https://pds.example.com'],
      }
      const mockResolver = createMockIdResolver(null)

      try {
        await assertEnrollment(config, 'did:plc:test', mockResolver)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(EnrollmentDeniedError)
        expect((err as EnrollmentDeniedError).reason).toBe('DidNotResolved')
      }
    })
  })
})
