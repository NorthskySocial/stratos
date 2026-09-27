import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectionCompactionBatch } from '../src/db/index.js'
import { ProjectionCompactor } from '../src/retention/index.js'

describe('ProjectionCompactor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('limits each run to short incremental passes', async () => {
    const compactProjection = vi.fn().mockResolvedValue({
      posts: 1,
      blobCacheEntries: 0,
      blobCacheKeys: [],
      syncCursors: 0,
      spaceCursors: 0,
      stagedRecords: 0,
      pendingVerifications: 0,
      hasMore: true,
    })
    const compactor = new ProjectionCompactor({
      store: { compactProjection },
    })

    await compactor.run()

    expect(compactProjection).toHaveBeenCalledTimes(4)
  })

  it('does not overlap a slow compaction run', async () => {
    let settle: (() => void) | undefined
    const compactProjection = vi
      .fn<() => Promise<ProjectionCompactionBatch>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = () =>
              resolve({
                posts: 0,
                blobCacheEntries: 0,
                blobCacheKeys: [],
                syncCursors: 0,
                spaceCursors: 0,
                stagedRecords: 0,
                pendingVerifications: 0,
                hasMore: false,
              })
          }),
      )
      .mockResolvedValue({
        posts: 0,
        blobCacheEntries: 0,
        blobCacheKeys: [],
        syncCursors: 0,
        spaceCursors: 0,
        stagedRecords: 0,
        pendingVerifications: 0,
        hasMore: false,
      })
    const compactor = new ProjectionCompactor({
      store: { compactProjection },
    })

    const first = compactor.run()
    const second = compactor.run()
    expect(compactProjection).toHaveBeenCalledOnce()
    settle?.()
    await Promise.all([first, second])
  })

  it('runs again after a completed pass releases the active marker', async () => {
    const compactProjection = vi.fn().mockResolvedValue({
      posts: 0,
      blobCacheEntries: 0,
      blobCacheKeys: [],
      syncCursors: 0,
      spaceCursors: 0,
      stagedRecords: 0,
      pendingVerifications: 0,
      hasMore: false,
    })
    const compactor = new ProjectionCompactor({
      store: { compactProjection },
    })

    await compactor.run()
    await compactor.run()

    expect(compactProjection).toHaveBeenCalledTimes(2)
  })

  it('uses one configured interval and stops it cleanly', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const compactProjection = vi.fn().mockResolvedValue({
      posts: 0,
      blobCacheEntries: 0,
      blobCacheKeys: [],
      syncCursors: 0,
      spaceCursors: 0,
      stagedRecords: 0,
      pendingVerifications: 0,
      hasMore: false,
    })
    const compactor = new ProjectionCompactor({
      store: {
        compactProjection,
      },
      intervalMs: 250,
    })
    try {
      compactor.start()
      compactor.start()
      expect(setIntervalSpy).toHaveBeenCalledOnce()
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 250)
      await vi.advanceTimersByTimeAsync(250)
      expect(compactProjection).toHaveBeenCalledOnce()
      await compactor.stop()
      expect(clearIntervalSpy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not clear a timer that was never started', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const compactor = new ProjectionCompactor({
      store: {
        compactProjection: vi.fn().mockResolvedValue({
          posts: 0,
          blobCacheEntries: 0,
          blobCacheKeys: [],
          syncCursors: 0,
          spaceCursors: 0,
          stagedRecords: 0,
          pendingVerifications: 0,
          hasMore: false,
        }),
      },
    })

    await compactor.stop()

    expect(clearIntervalSpy).not.toHaveBeenCalled()
  })

  it('reports a failed pass to the configured error sink', async () => {
    const failure = new Error('kaboom')
    const onError = vi.fn()
    const compactor = new ProjectionCompactor({
      store: { compactProjection: vi.fn().mockRejectedValue(failure) },
      onError,
    })

    await compactor.run()

    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('propagates a failed required startup pass', async () => {
    const failure = new Error('disk unavailable')
    const compactor = new ProjectionCompactor({
      store: { compactProjection: vi.fn().mockRejectedValue(failure) },
    })

    await expect(compactor.runRequired()).rejects.toThrow('disk unavailable')
  })

  it('shares an active required pass and releases it for a later startup pass', async () => {
    let settle: (() => void) | undefined
    const compactProjection = vi
      .fn<() => Promise<ProjectionCompactionBatch>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = () =>
              resolve({
                posts: 0,
                blobCacheEntries: 0,
                blobCacheKeys: [],
                syncCursors: 0,
                spaceCursors: 0,
                stagedRecords: 0,
                pendingVerifications: 0,
                hasMore: false,
              })
          }),
      )
      .mockResolvedValue({
        posts: 0,
        blobCacheEntries: 0,
        blobCacheKeys: [],
        syncCursors: 0,
        spaceCursors: 0,
        stagedRecords: 0,
        pendingVerifications: 0,
        hasMore: false,
      })
    const compactor = new ProjectionCompactor({ store: { compactProjection } })

    const first = compactor.runRequired()
    const second = compactor.runRequired()
    expect(compactProjection).toHaveBeenCalledOnce()
    settle?.()
    await Promise.all([first, second])
    await compactor.runRequired()

    expect(compactProjection).toHaveBeenCalledTimes(2)
  })

  it('acknowledges durable cache evictions only after the cache removes them', async () => {
    const completeBlobCacheEvictions = vi.fn().mockResolvedValue(undefined)
    const evictBlobCacheEntries = vi.fn().mockResolvedValue(undefined)
    const onResult = vi.fn()
    const compactor = new ProjectionCompactor({
      store: {
        compactProjection: vi.fn().mockResolvedValue({
          posts: 1,
          blobCacheEntries: 1,
          blobCacheKeys: ['cache-key'],
          syncCursors: 0,
          spaceCursors: 0,
          stagedRecords: 0,
          pendingVerifications: 0,
          hasMore: false,
        }),
        completeBlobCacheEvictions,
      },
      evictBlobCacheEntries,
      onResult,
    })

    await compactor.runRequired()

    expect(evictBlobCacheEntries).toHaveBeenCalledWith(['cache-key'])
    expect(completeBlobCacheEvictions).toHaveBeenCalledWith(['cache-key'])
    expect(onResult).toHaveBeenCalledWith({
      posts: 1,
      blobCacheEntries: 1,
      syncCursors: 0,
      spaceCursors: 0,
      stagedRecords: 0,
      pendingVerifications: 0,
      hasMore: false,
    })
  })

  it.each(['cache', 'acknowledgement'] as const)(
    'rejects a cache eviction without its %s dependency',
    async (missing) => {
      const compactProjection = vi.fn().mockResolvedValue({
        posts: 0,
        blobCacheEntries: 1,
        blobCacheKeys: ['cache-key'],
        syncCursors: 0,
        spaceCursors: 0,
        stagedRecords: 0,
        pendingVerifications: 0,
        hasMore: false,
      })
      const compactor = new ProjectionCompactor({
        store:
          missing === 'acknowledgement'
            ? { compactProjection }
            : {
                compactProjection,
                completeBlobCacheEvictions: vi.fn(),
              },
        ...(missing === 'acknowledgement'
          ? { evictBlobCacheEntries: vi.fn() }
          : {}),
      })

      await expect(compactor.runRequired()).rejects.toThrow(
        'durable blob cache eviction is not configured',
      )
    },
  )
})
