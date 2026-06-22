import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdResolver } from '../src/identity-resolver.js'

// Mock the @atproto/identity module
const mockHandleResolve = vi.fn()
const mockDidResolve = vi.fn()
vi.mock('@atproto/identity', () => {
  return {
    IdResolver: class {
      handle = {
        resolve: mockHandleResolve,
      }
      did = {
        resolve: mockDidResolve,
      }
    },
  }
})

describe('identity-resolver', () => {
  const mockCfg = {
    identity: {
      plcUrl: 'https://plc.directory',
    },
    enrollment: {
      serviceEnrollments: [],
    },
  } as any

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any

  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should resolve handle normally if the standard resolution succeeds', async () => {
    const did = 'did:plc:shinji-ikari'
    mockHandleResolve.mockResolvedValue(did)

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve('shinji.nerv.jp')

    expect(result).toBe(did)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('should fallback to PLC directory if standard resolution fails', async () => {
    const handle = 'asuka.nerv.jp'
    const did = 'did:plc:asuka-langley'

    mockHandleResolve.mockRejectedValue(new Error('NXDOMAIN'))

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => did,
    })

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve(handle)

    expect(result).toBe(did)
    expect(mockFetch).toHaveBeenCalledWith(
      `https://plc.directory/did-by-handle/${encodeURIComponent(handle)}`,
    )
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ handle, err: 'NXDOMAIN' }),
      'standard handle resolution failed, trying PLC fallback',
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      { handle, did },
      'resolved handle via PLC directory fallback',
    )
  })

  it('should fallback to PLC directory if standard resolution returns undefined', async () => {
    const handle = 'rei.nerv.jp'
    const did = 'did:plc:rei-ayanami'

    mockHandleResolve.mockResolvedValue(undefined)

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => did,
    })

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve(handle)

    expect(result).toBe(did)
    expect(mockFetch).toHaveBeenCalled()
  })

  it('should return undefined if both standard resolution and PLC fallback fail', async () => {
    const handle = 'misato.nerv.jp'

    mockHandleResolve.mockRejectedValue(new Error('Fail'))
    mockFetch.mockRejectedValue(new Error('PLC Fail'))

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve(handle)

    expect(result).toBeUndefined()
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ handle, err: 'Fail' }),
      'standard handle resolution failed, trying PLC fallback',
    )
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ handle, err: 'PLC Fail' }),
      'PLC handle resolution fallback failed',
    )
  })

  it('should return undefined if PLC fallback returns non-DID string', async () => {
    const handle = 'penpen.nerv.jp'

    mockHandleResolve.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => 'not-a-did',
    })

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve(handle)

    expect(result).toBeUndefined()
  })

  it('should return undefined if PLC fallback returns empty string', async () => {
    const handle = 'gendo.nerv.jp'

    mockHandleResolve.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '',
    })

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve(handle)

    expect(result).toBeUndefined()
  })

  it('should return undefined if PLC fallback response is not ok', async () => {
    const handle = 'kaworu.nerv.jp'

    mockHandleResolve.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    })

    const idResolver = createIdResolver(mockCfg, mockFetch, mockLogger)
    const result = await idResolver.handle.resolve(handle)

    expect(result).toBeUndefined()
  })
})

describe('identity-resolver service-key shortcut', () => {
  const serviceDid = 'did:web:appview.test'
  const signingKey = 'did:key:zQ3shqu5PGsBcRm7NU1uXcmLsfuNV4LvTTuChtYJbiXnjQaE5'

  const cfgWithServiceKey = {
    identity: { plcUrl: 'https://plc.directory' },
    enrollment: {
      serviceEnrollments: [
        { did: serviceDid, boundaries: ['swordsmith'], signingKey },
      ],
    },
  } as any

  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves an enrolled service DID from the configured signing key without network resolution', async () => {
    const idResolver = createIdResolver(cfgWithServiceKey, mockFetch)
    const doc = await idResolver.did.resolve(serviceDid)

    expect(mockDidResolve).not.toHaveBeenCalled()
    expect(doc).toEqual({
      id: serviceDid,
      verificationMethod: [
        {
          id: `${serviceDid}#atproto`,
          type: 'Multikey',
          controller: serviceDid,
          publicKeyMultibase: signingKey.slice('did:key:'.length),
        },
      ],
    })
  })

  it('delegates non-enrolled DIDs to the underlying resolver', async () => {
    const otherDid = 'did:plc:shinji-ikari'
    const otherDoc = { id: otherDid }
    mockDidResolve.mockResolvedValue(otherDoc)

    const idResolver = createIdResolver(cfgWithServiceKey, mockFetch)
    const doc = await idResolver.did.resolve(otherDid)

    expect(mockDidResolve).toHaveBeenCalledWith(otherDid, undefined)
    expect(doc).toBe(otherDoc)
  })

  it('does not install a shortcut for service enrollments without a signing key', async () => {
    const cfg = {
      identity: { plcUrl: 'https://plc.directory' },
      enrollment: {
        serviceEnrollments: [{ did: serviceDid, boundaries: ['swordsmith'] }],
      },
    } as any
    const resolved = { id: serviceDid }
    mockDidResolve.mockResolvedValue(resolved)

    const idResolver = createIdResolver(cfg, mockFetch)
    const doc = await idResolver.did.resolve(serviceDid)

    expect(mockDidResolve).toHaveBeenCalledWith(serviceDid)
    expect(doc).toBe(resolved)
  })
})
