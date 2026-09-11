import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdResolver } from '../src/storage/db.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('indexer identity security', () => {
  it('blocks private DID hosts with the indexer SDK and cache', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'))
    const resolver = createIdResolver({ plcUrl: 'https://plc.nerv.jp' })
    await expect(resolver.did.resolve('did:web:127.0.0.1')).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the configured PLC and DID cache', async () => {
    vi.useFakeTimers()
    const did = 'did:plc:rei'
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ id: did })))
    const resolver = createIdResolver({ plcUrl: 'http://127.0.0.1:2582' })
    await expect(resolver.did.resolve(did)).resolves.toEqual({ id: did })
    await resolver.did.resolve(did)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:2582/did%3Aplc%3Arei'),
      expect.objectContaining({ redirect: 'error' }),
    )
  })
})
