/**
 * Unit tests for `replayStoreFromCache` — the structural seam that adapts the
 * process cache into a ReplayStore only when it exposes `setNxEx`.
 */
import { describe, expect, it } from 'vitest'
import {
  ReplayStore,
  replayStoreFromCache,
  type NxExStore,
} from '../src/infra/auth/replay-store.js'

/** In-memory SET-NX-EX store. First set of a key wins. */
class MemoryNxExStore implements NxExStore {
  private readonly seen = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

describe('replayStoreFromCache', () => {
  it('returns undefined when no cache is configured', () => {
    expect(replayStoreFromCache(undefined)).toBeUndefined()
  })

  it('returns undefined for a cache without setNxEx', () => {
    expect(replayStoreFromCache({})).toBeUndefined()
  })

  it('wraps a setNxEx-capable cache into a working ReplayStore', async () => {
    const store = replayStoreFromCache(new MemoryNxExStore())
    expect(store).toBeInstanceOf(ReplayStore)
    await expect(store!.consumeOnce('space-dpop', 'jti-rei', 300)).resolves.toBe(
      true,
    )
    await expect(store!.consumeOnce('space-dpop', 'jti-rei', 300)).resolves.toBe(
      false,
    )
  })
})
