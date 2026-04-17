import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PdsTokenVerifier } from '../src/infra/auth/index.js'
import { IdResolver } from '@atproto/identity'

describe('PdsTokenVerifier', () => {
  let mockIdResolver: any
  let mockFetch: any
  let verifier: PdsTokenVerifier

  const ALICE_DID = 'did:plc:alice'
  const PDS_ENDPOINT = 'https://pds.alice.com'
  const ISSUER = 'https://bsky.social'
  const AUDIENCE = 'https://stratos.zone'

  beforeEach(() => {
    mockIdResolver = {
      did: {
        resolve: vi.fn(),
      },
    }

    mockFetch = vi.fn()

    verifier = new PdsTokenVerifier({
      idResolver: mockIdResolver as unknown as IdResolver,
      audience: AUDIENCE,
      fetch: mockFetch,
    })
  })

  const createToken = (payload: object) => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.signature`
  }

  describe('getPdsEndpointFromDid', () => {
    it('resolves PDS endpoint from DID document', async () => {
      mockIdResolver.did.resolve.mockResolvedValue({
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: PDS_ENDPOINT,
          },
        ],
      })

      const endpoint = await verifier.getPdsEndpointFromDid(ALICE_DID)
      expect(endpoint).toBe(PDS_ENDPOINT)
      expect(mockIdResolver.did.resolve).toHaveBeenCalledWith(ALICE_DID)
    })

    it('handles DID with full ID in service', async () => {
      mockIdResolver.did.resolve.mockResolvedValue({
        service: [
          {
            id: `${ALICE_DID}#atproto_pds`,
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: PDS_ENDPOINT,
          },
        ],
      })

      const endpoint = await verifier.getPdsEndpointFromDid(ALICE_DID)
      expect(endpoint).toBe(PDS_ENDPOINT)
    })

    it('returns null if no PDS service found', async () => {
      mockIdResolver.did.resolve.mockResolvedValue({
        service: [
          {
            id: '#other_service',
            type: 'SomeOtherType',
            serviceEndpoint: 'https://other.com',
          },
        ],
      })

      const endpoint = await verifier.getPdsEndpointFromDid(ALICE_DID)
      expect(endpoint).toBeNull()
    })

    it('returns null if resolution fails', async () => {
      mockIdResolver.did.resolve.mockRejectedValue(
        new Error('Resolution failed'),
      )
      const endpoint = await verifier.getPdsEndpointFromDid(ALICE_DID)
      expect(endpoint).toBeNull()
    })
  })

  describe('verify', () => {
    const validPayload = {
      sub: ALICE_DID,
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }

    beforeEach(() => {
      // Default PDS resolution
      mockIdResolver.did.resolve.mockResolvedValue({
        service: [{ id: '#atproto_pds', serviceEndpoint: PDS_ENDPOINT }],
      })

      // Default Metadata fetch
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ authorization_servers: [ISSUER] }),
      })
    })

    it('verifies a valid token', async () => {
      const token = createToken(validPayload)
      const result = await verifier.verify(token)

      expect(result.active).toBe(true)
      if (result.active) {
        expect(result.sub).toBe(ALICE_DID)
        expect(result.iss).toBe(ISSUER)
      }
    })

    it('returns inactive for malformed JWT', async () => {
      const result = await verifier.verify('not.a.jwt')
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toContain('Failed to decode JWT payload')
      }
    })

    it('returns inactive if subject is missing or invalid', async () => {
      const token = createToken({ iss: ISSUER, aud: AUDIENCE })
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toBe('Invalid subject claim')
      }

      const invalidSubToken = createToken({ sub: 'not-a-did', iss: ISSUER })
      const result2 = await verifier.verify(invalidSubToken)
      expect(result2.active).toBe(false)
    })

    it('returns inactive if issuer is missing or invalid', async () => {
      const token = createToken({ sub: ALICE_DID, aud: AUDIENCE })
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toBe('Token missing issuer (iss) claim')
      }

      const invalidIssToken = createToken({ sub: ALICE_DID, iss: 'not-a-url' })
      const result2 = await verifier.verify(invalidIssToken)
      expect(result2.active).toBe(false)
    })

    it('returns inactive if PDS cannot be resolved', async () => {
      mockIdResolver.did.resolve.mockResolvedValue(null)
      const token = createToken(validPayload)
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toContain('Could not resolve PDS endpoint')
      }
    })

    it('returns inactive if PDS metadata fetch fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 })
      const token = createToken(validPayload)
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toContain('metadata request failed')
      }
    })

    it('returns inactive if issuer mismatch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_servers: ['https://other-issuer.com'],
        }),
      })
      const token = createToken(validPayload)
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toContain('does not match PDS auth server')
      }
    })

    it('returns inactive if token is expired', async () => {
      const expiredPayload = {
        ...validPayload,
        exp: Math.floor(Date.now() / 1000) - 60,
      }
      const token = createToken(expiredPayload)
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toBe('Token expired')
      }
    })

    it('returns inactive if audience mismatch', async () => {
      const wrongAudPayload = {
        ...validPayload,
        aud: 'https://wrong-audience.com',
      }
      const token = createToken(wrongAudPayload)
      const result = await verifier.verify(token)
      expect(result.active).toBe(false)
      if (!result.active) {
        expect(result.error).toBe('Audience mismatch')
      }
    })

    it('handles multiple audiences', async () => {
      const multiAudPayload = {
        ...validPayload,
        aud: ['https://other.com', AUDIENCE],
      }
      const token = createToken(multiAudPayload)
      const result = await verifier.verify(token)
      expect(result.active).toBe(true)
    })

    it('caches successful verification', async () => {
      const token = createToken(validPayload)

      // First call
      await verifier.verify(token)
      expect(mockIdResolver.did.resolve).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Second call (cached)
      const result = await verifier.verify(token)
      expect(result.active).toBe(true)
      expect(mockIdResolver.did.resolve).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('evicts from cache when limit reached', async () => {
      const smallCacheVerifier = new PdsTokenVerifier({
        idResolver: mockIdResolver,
        verifyCacheMaxSize: 2,
        fetch: mockFetch,
      })

      const token1 = createToken({ ...validPayload, sub: 'did:plc:1' })
      const token2 = createToken({ ...validPayload, sub: 'did:plc:2' })
      const token3 = createToken({ ...validPayload, sub: 'did:plc:3' })

      await smallCacheVerifier.verify(token1)
      await smallCacheVerifier.verify(token2)
      await smallCacheVerifier.verify(token3)

      // token1 should be evicted (FIFO-ish since it's a Map)
      mockIdResolver.did.resolve.mockClear()
      mockFetch.mockClear()

      await smallCacheVerifier.verify(token1)
      expect(mockIdResolver.did.resolve).toHaveBeenCalledTimes(1)
    })

    it('clears cache', async () => {
      const token = createToken(validPayload)
      await verifier.verify(token)

      verifier.clearCache()

      mockIdResolver.did.resolve.mockClear()
      mockFetch.mockClear()

      await verifier.verify(token)
      expect(mockIdResolver.did.resolve).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })
})
