import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DidDocument, DidPlcResolver } from '@atproto/identity'
import { MemoryCache } from '@atproto/identity'

import {
  BoundedDidCache,
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

function didCache(
  resolver: ReturnType<typeof createIdResolver>,
): BoundedDidCache {
  return resolver.did.cache as BoundedDidCache
}

function internalMap(
  resolver: ReturnType<typeof createIdResolver>,
): Map<string, CacheEntry> {
  return (resolver.did.cache as unknown as { cache: Map<string, CacheEntry> })
    .cache
}

/** The eviction order is keyed on the DID alone, so a bare document suffices. */
function doc(did: string): DidDocument {
  return { id: did }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createIdResolver', () => {
  it('backs the resolver with a size-bounded in-memory DID cache', () => {
    const resolver = createIdResolver(cfg)
    expect(resolver.did.cache).toBeInstanceOf(BoundedDidCache)
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

  it('holds the max size while entries are written, before any sweep', async () => {
    const resolver = createIdResolver(cfg)
    const cache = didCache(resolver)
    for (let i = 0; i < DID_CACHE_MAX_SIZE + 50; i++) {
      await cache.cacheDid(`did:plc:kusanagi${i}`, doc(`did:plc:kusanagi${i}`))
    }

    expect(internalMap(resolver).size).toBe(DID_CACHE_MAX_SIZE)
  })

  it('keeps every entry when the writes stop exactly at the max size', async () => {
    const resolver = createIdResolver(cfg)
    const cache = didCache(resolver)
    for (let i = 0; i < DID_CACHE_MAX_SIZE; i++) {
      await cache.cacheDid(`did:plc:vash${i}`, doc(`did:plc:vash${i}`))
    }

    expect(internalMap(resolver).size).toBe(DID_CACHE_MAX_SIZE)
    expect(internalMap(resolver).has('did:plc:vash0')).toBe(true)
  })

  it('evicts the least recently written entry once full', async () => {
    const resolver = createIdResolver(cfg)
    const cache = didCache(resolver)
    for (let i = 0; i < DID_CACHE_MAX_SIZE; i++) {
      await cache.cacheDid(`did:plc:jigen${i}`, doc(`did:plc:jigen${i}`))
    }

    await cache.cacheDid('did:plc:goemon', doc('did:plc:goemon'))

    const map = internalMap(resolver)
    expect(map.size).toBe(DID_CACHE_MAX_SIZE)
    expect(map.has('did:plc:jigen0')).toBe(false)
    expect(map.has('did:plc:jigen1')).toBe(true)
    expect(map.has('did:plc:goemon')).toBe(true)
  })

  it('refreshing an entry spares it from the next eviction', async () => {
    const resolver = createIdResolver(cfg)
    const cache = didCache(resolver)
    for (let i = 0; i < DID_CACHE_MAX_SIZE; i++) {
      await cache.cacheDid(`did:plc:tetsuo${i}`, doc(`did:plc:tetsuo${i}`))
    }

    // Rewriting the oldest entry must move it to the back of the queue, so the
    // second-oldest is discarded in its place.
    await cache.cacheDid('did:plc:tetsuo0', doc('did:plc:tetsuo0'))
    await cache.cacheDid('did:plc:kaneda', doc('did:plc:kaneda'))

    const map = internalMap(resolver)
    expect(map.size).toBe(DID_CACHE_MAX_SIZE)
    expect(map.has('did:plc:tetsuo0')).toBe(true)
    expect(map.has('did:plc:tetsuo1')).toBe(false)
  })

  it('does not grow the cache when the same DID is written repeatedly', async () => {
    const resolver = createIdResolver(cfg)
    const cache = didCache(resolver)
    for (let i = 0; i < 5; i++) {
      await cache.cacheDid('did:plc:motoko', doc('did:plc:motoko'))
    }

    expect(internalMap(resolver).size).toBe(1)
  })
})
