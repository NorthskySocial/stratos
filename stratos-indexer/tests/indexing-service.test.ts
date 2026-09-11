import { RepoSubscription } from '@atproto/bsky'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createIdResolver,
  createIndexingService,
} from '../src/storage/db.js'
import type { IndexerConfig } from '../src/config.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('upstream indexing service', () => {
  it('uses the protected resolver and bounded background queue without starting another subscription', async () => {
    vi.useFakeTimers()
    const start = vi.spyOn(RepoSubscription.prototype, 'start')
    const fetch = vi.spyOn(globalThis, 'fetch')
    const db = createDatabase({
      postgresUrl: 'postgresql://shinji@localhost/nerv',
      schema: 'nerv',
      poolSize: 1,
    })
    const idResolver = createIdResolver({ plcUrl: 'https://plc.nerv.jp' })
    const { indexingService, background } = createIndexingService(
      db,
      idResolver,
      {
        pds: { repoProvider: 'wss://pds.nerv.jp' },
        worker: { backgroundQueueConcurrency: 1, backgroundQueueMaxSize: 2 },
      } as IndexerConfig,
    )
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      expect(indexingService.db).toBe(db)
      expect(indexingService.background).toBe(background)
      expect(indexingService.idResolver).toBe(idResolver)
      await expect(
        indexingService.idResolver.did.resolve('did:web:127.0.0.1'),
      ).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()

      const running = vi.fn(async (context) => {
        expect(context).toBe(db)
        await pending
      })
      const queued = vi.fn(async () => {})
      const overflow = vi.fn(async () => {})
      background.add(running)
      background.add(queued)
      background.add(overflow)
      expect(running).toHaveBeenCalledTimes(1)
      expect(queued).not.toHaveBeenCalled()
      release()
      await background.processAll()
      expect(queued).toHaveBeenCalledTimes(1)
      expect(overflow).not.toHaveBeenCalled()
    } finally {
      release()
      await background.destroy()
      await db.close()
    }
  })
})
