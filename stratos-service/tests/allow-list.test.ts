import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Logger } from '@northskysocial/stratos-core'
import { ExternalAllowListProvider } from '../src/features/enrollment/internal/allow-list.js'

describe('ExternalAllowListProvider', () => {
  const mockUrl = 'https://example.com/allowlist.txt'
  const mockBootstrapName = 'test-allowlist'

  let mockLogger: Logger
  let mockCache: any
  let mockPipeline: any

  beforeEach(() => {
    vi.useFakeTimers()

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    mockPipeline = {
      del: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(undefined),
    }

    mockCache = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      sadd: vi.fn(),
      sismember: vi.fn(),
      pipeline: vi.fn().mockReturnValue(mockPipeline),
      close: vi.fn().mockResolvedValue(undefined),
    }

    // Mock global fetch
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('should fetch and parse DIDs from external URL', async () => {
    const mockDids = ['did:plc:goku', 'did:plc:vegeta']
    const mockResponse = {
      ok: true,
      text: vi
        .fn()
        .mockResolvedValue(
          mockDids.join('\n') + '\nnot-a-did\n  did:plc:piccolo  ',
        ),
    }
    ;(global.fetch as any).mockResolvedValue(mockResponse)

    const provider = new ExternalAllowListProvider(
      mockUrl,
      undefined,
      undefined,
      mockLogger,
    )
    await provider.refresh()

    expect(global.fetch).toHaveBeenCalledWith(mockUrl)
    expect(await provider.isAllowed('did:plc:goku')).toBe(true)
    expect(await provider.isAllowed('did:plc:vegeta')).toBe(true)
    expect(await provider.isAllowed('did:plc:piccolo')).toBe(true)
    expect(await provider.isAllowed('did:plc:frieza')).toBe(false)
  })

  it('should bootstrap cache if provided', async () => {
    const mockDids = ['did:plc:gon', 'did:plc:killua']
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue(mockDids.join('\n')),
    }
    ;(global.fetch as any).mockResolvedValue(mockResponse)

    const provider = new ExternalAllowListProvider(
      mockUrl,
      mockCache,
      mockBootstrapName,
      mockLogger,
    )
    await provider.refresh()

    expect(mockCache.pipeline).toHaveBeenCalled()
    expect(mockPipeline.del).toHaveBeenCalledWith(mockBootstrapName)
    expect(mockPipeline.sadd).toHaveBeenCalledWith(
      mockBootstrapName,
      'did:plc:gon',
      'did:plc:killua',
    )
    expect(mockPipeline.exec).toHaveBeenCalled()
  })

  it('should use cache if DID not in local set', async () => {
    const provider = new ExternalAllowListProvider(
      mockUrl,
      mockCache,
      mockBootstrapName,
      mockLogger,
    )

    mockCache.sismember.mockResolvedValue(true)
    expect(await provider.isAllowed('did:plc:kurapika')).toBe(true)
    expect(mockCache.sismember).toHaveBeenCalledWith(
      mockBootstrapName,
      'did:plc:kurapika',
    )

    mockCache.sismember.mockResolvedValue(false)
    expect(await provider.isAllowed('did:plc:leorio')).toBe(false)
  })

  it('should handle fetch errors gracefully', async () => {
    const mockResponse = {
      ok: false,
      statusText: 'Not Found',
    }
    ;(global.fetch as any).mockResolvedValue(mockResponse)

    const provider = new ExternalAllowListProvider(
      mockUrl,
      undefined,
      undefined,
      mockLogger,
    )
    await provider.refresh()

    expect(mockLogger.error).toHaveBeenCalled()
    expect(await provider.isAllowed('did:plc:any')).toBe(false)
  })

  it('should start and stop refresh interval', async () => {
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue('did:plc:yusuke'),
    }
    ;(global.fetch as any).mockResolvedValue(mockResponse)

    const refreshMs = 1000
    const provider = new ExternalAllowListProvider(
      mockUrl,
      mockCache,
      mockBootstrapName,
      mockLogger,
      refreshMs,
    )

    await provider.start()
    expect(global.fetch).toHaveBeenCalledTimes(1)

    // Advance time
    await vi.advanceTimersByTimeAsync(refreshMs)
    expect(global.fetch).toHaveBeenCalledTimes(2)

    await provider.stop()
    expect(mockCache.close).toHaveBeenCalled()

    // Advance time again, should not call fetch
    await vi.advanceTimersByTimeAsync(refreshMs)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('should handle large number of DIDs by chunking sadd calls', async () => {
    const largeNumber = 2500
    const mockDids = Array.from(
      { length: largeNumber },
      (_, i) => `did:plc:character${i}`,
    )
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue(mockDids.join('\n')),
    }
    ;(global.fetch as any).mockResolvedValue(mockResponse)

    const provider = new ExternalAllowListProvider(
      mockUrl,
      mockCache,
      mockBootstrapName,
      mockLogger,
    )
    await provider.refresh()

    expect(mockPipeline.sadd).toHaveBeenCalledTimes(3) // 1000 + 1000 + 500
    expect(mockPipeline.sadd).toHaveBeenNthCalledWith(
      1,
      mockBootstrapName,
      ...mockDids.slice(0, 1000),
    )
    expect(mockPipeline.sadd).toHaveBeenNthCalledWith(
      2,
      mockBootstrapName,
      ...mockDids.slice(1000, 2000),
    )
    expect(mockPipeline.sadd).toHaveBeenNthCalledWith(
      3,
      mockBootstrapName,
      ...mockDids.slice(2000, 2500),
    )
  })
})
