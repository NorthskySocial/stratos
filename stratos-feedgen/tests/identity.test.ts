import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DidPlcResolver } from '@atproto/identity'
import { MemoryCache } from '@atproto/identity'

import {
  createIdResolver,
  DID_CACHE_MAX_SIZE,
  DID_CACHE_MAX_TTL,
  DID_CACHE_STALE_TTL,
  DID_CACHE_SWEEP_INTERVAL,
} from '../src/auth/identity.js'
import type { FeedgenConfig } from '../src/config.js'

// Distinct from both DEFAULT_PLC_URL and @atproto/identity's own fallback so a
// dropped `plcUrl` option would fail the "reaches the resolver" assertion below.
const cfg = {
  feedgenPlcUrl: 'https://plc.nerv.example',
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

  it('configures the DID resolver with the feedgen PLC URL', () => {
    const resolver = createIdResolver(cfg)
    const plcResolver = resolver.did.methods.get('plc') as DidPlcResolver
    expect(plcResolver.plcUrl).toBe(cfg.feedgenPlcUrl)
  })

  it('passes the stale TTL through to the underlying MemoryCache', () => {
    const resolver = createIdResolver(cfg)
    const cache = resolver.did.cache as MemoryCache
    expect(cache.staleTTL).toBe(300_000)
    expect(cache.staleTTL).toBe(DID_CACHE_STALE_TTL)
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

  it('keeps an entry exactly at the hard TTL boundary at sweep time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const resolver = createIdResolver(cfg)
    const cache = internalMap(resolver)
    // The sweep fires at t = DID_CACHE_SWEEP_INTERVAL, so backdating updatedAt
    // by exactly DID_CACHE_MAX_TTL from that moment makes `now - updatedAt`
    // equal to the TTL exactly (age === TTL, not age > TTL).
    cache.set('did:plc:faye', {
      did: 'did:plc:faye',
      doc: {},
      updatedAt: DID_CACHE_SWEEP_INTERVAL - DID_CACHE_MAX_TTL,
    })

    vi.advanceTimersByTime(DID_CACHE_SWEEP_INTERVAL)

    expect(cache.has('did:plc:faye')).toBe(true)
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

  it('keeps the cache when it is exactly at the max size', () => {
    vi.useFakeTimers()
    const resolver = createIdResolver(cfg)
    const cache = internalMap(resolver)
    for (let i = 0; i < DID_CACHE_MAX_SIZE; i++) {
      cache.set(`did:plc:faye${i}`, {
        did: `did:plc:faye${i}`,
        doc: {},
        updatedAt: Date.now(),
      })
    }

    vi.advanceTimersByTime(DID_CACHE_SWEEP_INTERVAL)

    expect(cache.size).toBe(DID_CACHE_MAX_SIZE)
  })
})
