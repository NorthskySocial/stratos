import type { IdResolver } from '@atproto/identity'

export const HANDLE_CACHE_TTL_MS = 15 * 60 * 1000
export const HANDLE_CACHE_MAX_SIZE = 10_000

interface HandleCacheEntry {
  handle?: string
  expiresAt: number
}

/** Bounded handle cache with negative caching and concurrent lookup coalescing. */
export class CachedHandleResolver {
  private readonly cache = new Map<string, HandleCacheEntry>()
  private readonly pending = new Map<string, Promise<string | undefined>>()

  constructor(
    private readonly idResolver: Pick<IdResolver, 'did'>,
    private readonly ttlMs = HANDLE_CACHE_TTL_MS,
    private readonly maxSize = HANDLE_CACHE_MAX_SIZE,
  ) {}

  resolve(did: string): Promise<string | undefined> {
    const cached = this.cache.get(did)
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(did)
      this.cache.set(did, cached)
      return Promise.resolve(cached.handle)
    }
    if (cached) this.cache.delete(did)

    const active = this.pending.get(did)
    if (active) return active

    const lookup = this.lookup(did).finally(() => this.pending.delete(did))
    this.pending.set(did, lookup)
    return lookup
  }

  private async lookup(did: string): Promise<string | undefined> {
    let handle: string | undefined
    try {
      handle = (await this.idResolver.did.resolveAtprotoData(did)).handle
    } catch {
      handle = undefined
    }
    this.cache.set(did, { handle, expiresAt: Date.now() + this.ttlMs })
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return handle
  }
}
