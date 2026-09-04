import { describe, expect, it, vi } from 'vitest'
import { CachedHandleResolver } from '../src/auth/handle-resolver.js'

describe('CachedHandleResolver', () => {
  it('coalesces concurrent lookups and serves the cached handle', async () => {
    const resolveAtprotoData = vi.fn(async (did: string) => ({
      did,
      handle: 'faye.example',
      signingKey: 'did:key:faye',
      pds: 'https://pds.example',
    }))
    const resolver = new CachedHandleResolver(
      { did: { resolveAtprotoData } } as never,
      60_000,
      10,
    )

    await expect(
      Promise.all([
        resolver.resolve('did:plc:faye'),
        resolver.resolve('did:plc:faye'),
      ]),
    ).resolves.toEqual(['faye.example', 'faye.example'])
    await expect(resolver.resolve('did:plc:faye')).resolves.toBe('faye.example')
    expect(resolveAtprotoData).toHaveBeenCalledOnce()
  })

  it('negative-caches failed resolutions', async () => {
    const resolveAtprotoData = vi.fn().mockRejectedValue(new Error('offline'))
    const resolver = new CachedHandleResolver(
      { did: { resolveAtprotoData } } as never,
      60_000,
      10,
    )

    await expect(resolver.resolve('did:plc:spike')).resolves.toBeUndefined()
    await expect(resolver.resolve('did:plc:spike')).resolves.toBeUndefined()
    expect(resolveAtprotoData).toHaveBeenCalledOnce()
  })
})
