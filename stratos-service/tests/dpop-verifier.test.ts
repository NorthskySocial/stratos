import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { DpopVerificationError, DpopVerifier } from '../src/infra/auth'

describe('DpopVerifier', () => {
  const mockEnrollmentStore = {
    isEnrolled: vi.fn(),
  }

  const mockDpopManager = {
    checkProof: vi.fn(),
    nextNonce: vi.fn().mockReturnValue('test-nonce'),
  }

  const mockLogger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }

  const config = {
    serviceDid: 'did:web:stratos.actor',
    serviceEndpoint: 'https://stratos.actor',
    enrollmentStore: mockEnrollmentStore as any,
    dpopManager: mockDpopManager as any,
    logger: mockLogger as any,
  }

  const verifier = new DpopVerifier(config)

  beforeEach(() => {
    vi.clearAllMocks()
    // Default mock implementation
    mockDpopManager.checkProof.mockResolvedValue({ jkt: 'test-jkt' })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(true)
  })

  it('should verify a valid DPoP request', async () => {
    const did = 'did:plc:user1'
    const claims = {
      sub: did,
      iss: 'https://pds.example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
      scope: 'atproto',
      cnf: { jkt: 'test-jkt' },
    }
    const accessToken = jwt.sign(claims, 'secret')

    const req = {
      method: 'GET',
      url: '/xrpc/some.procedure',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: 'test-proof',
      },
    }

    const result = await verifier.verify(req as any)

    expect(result).toEqual({
      type: 'dpop',
      did,
      scope: 'atproto',
      pdsEndpoint: 'https://pds.example.com',
      tokenType: 'DPoP',
    })
  })

  it('should throw if authorization header is missing', async () => {
    const req = {
      method: 'GET',
      url: '/xrpc/some.procedure',
      headers: {},
    }

    await expect(verifier.verify(req as any)).rejects.toThrow(
      DpopVerificationError,
    )
    await expect(verifier.verify(req as any)).rejects.toMatchObject({
      code: 'missing_auth',
    })
  })

  it('should throw if token is expired', async () => {
    const did = 'did:plc:user1'
    const claims = {
      sub: did,
      iss: 'https://pds.example.com',
      exp: Math.floor(Date.now() / 1000) - 60,
      cnf: { jkt: 'test-jkt' },
    }
    const accessToken = jwt.sign(claims, 'secret')

    const req = {
      method: 'GET',
      url: '/xrpc/some.procedure',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: 'test-proof',
      },
    }

    mockDpopManager.checkProof.mockResolvedValue({ jkt: 'test-jkt' })

    await expect(verifier.verify(req as any)).rejects.toThrow('Token expired')
  })

  it('should throw if key binding mismatch', async () => {
    const did = 'did:plc:user1'
    const claims = {
      sub: did,
      iss: 'https://pds.example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
      cnf: { jkt: 'token-jkt' },
    }
    const accessToken = jwt.sign(claims, 'secret')

    const req = {
      method: 'GET',
      url: '/xrpc/some.procedure',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: 'test-proof',
      },
    }

    mockDpopManager.checkProof.mockResolvedValue({ jkt: 'proof-jkt' })

    await expect(verifier.verify(req as any)).rejects.toMatchObject({
      code: 'key_binding_mismatch',
    })
  })

  it('should throw if DPoP htm (method) mismatch', async () => {
    const claims = {
      sub: 'did:plc:user1',
      iss: 'https://pds.example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
      cnf: { jkt: 'test-jkt' },
    }
    const accessToken = jwt.sign(claims, 'secret')

    const req = {
      method: 'POST',
      url: '/xrpc/some.procedure',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: 'test-proof',
      },
    }

    mockDpopManager.checkProof.mockRejectedValue(new Error('htm mismatch'))

    await expect(verifier.verify(req as any)).rejects.toThrow('htm mismatch')
  })

  it('should throw if DPoP htu (URL) mismatch', async () => {
    const claims = {
      sub: 'did:plc:user1',
      iss: 'https://pds.example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
      cnf: { jkt: 'test-jkt' },
    }
    const accessToken = jwt.sign(claims, 'secret')

    const req = {
      method: 'GET',
      url: '/xrpc/wrong.procedure',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: 'test-proof',
      },
    }

    mockDpopManager.checkProof.mockRejectedValue(new Error('htu mismatch'))

    await expect(verifier.verify(req as any)).rejects.toThrow('htu mismatch')
  })

  it('should throw if user not enrolled', async () => {
    const did = 'did:plc:user1'
    const claims = {
      sub: did,
      iss: 'https://pds.example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
      cnf: { jkt: 'test-jkt' },
    }
    const accessToken = jwt.sign(claims, 'secret')

    const req = {
      method: 'GET',
      url: '/xrpc/some.procedure',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: 'test-proof',
      },
    }

    mockDpopManager.checkProof.mockResolvedValue({ jkt: 'test-jkt' })
    mockEnrollmentStore.isEnrolled.mockResolvedValue(false)

    await expect(verifier.verify(req as any)).rejects.toMatchObject({
      code: 'not_enrolled',
    })
  })
})
