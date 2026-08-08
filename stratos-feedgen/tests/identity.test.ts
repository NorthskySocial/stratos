import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCache } from '@atproto/identity'

import {
  createIdResolver,
  DID_CACHE_MAX_SIZE,
  DID_CACHE_MAX_TTL,
  DID_CACHE_SWEEP_INTERVAL,
} from '../src/auth/identity.js'
import type { FeedgenConfig } from '../src/config.js'

const cfg = {
  feedgenPlcUrl: 'https://plc.directory',
} as unknown as FeedgenConfig

interface CacheEntry {
  did: string
  doc: unknown
  updatedAt: number
}

function internalMap(
  resolver: ReturnType<typeof createIdResolver>,
): Map<string, CacheEntry> {
  return (resolver.did.cache as unknown as { cache: Map<string, CacheEntry> })
    .cache
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createIdResolver', () => {
  it('backs the resolver with an in-memory DID cache', () => {
    const resolver = createIdResolver(cfg)
    expect(resolver.did.cache).toBeInstanceOf(MemoryCache)
  })

  it('sweeps entries past the hard TTL', () => {
    vi.useFakeTimers()
    const resolver = createIdResolver(cfg)
    const cache = internalMap(resolver)
    cache.set('did:plc:lain', {
      did: 'did:plc:lain',
      doc: {},
      updatedAt: Date.now() - DID_CACHE_MAX_TTL - 1,
    })

    vi.advanceTimersByTime(DID_CACHE_SWEEP_INTERVAL)

    expect(cache.has('did:plc:lain')).toBe(false)
  })

  it('keeps entries that have not exceeded the hard TTL', () => {
    vi.useFakeTimers()
    const resolver = createIdResolver(cfg)
    const cache = internalMap(resolver)
    cache.set('did:plc:spike', {
      did: 'did:plc:spike',
      doc: {},
      updatedAt: Date.now(),
    })

    vi.advanceTimersByTime(DID_CACHE_SWEEP_INTERVAL)

    expect(cache.has('did:plc:spike')).toBe(true)
  })

  it('clears the whole cache when it grows past the max size', () => {
    vi.useFakeTimers()
    const resolver = createIdResolver(cfg)
    const cache = internalMap(resolver)
    for (let i = 0; i <= DID_CACHE_MAX_SIZE; i++) {
      cache.set(`did:plc:faye${i}`, {
        did: `did:plc:faye${i}`,
        doc: {},
        updatedAt: Date.now(),
      })
    }

    vi.advanceTimersByTime(DID_CACHE_SWEEP_INTERVAL)

    expect(cache.size).toBe(0)
  })
})
