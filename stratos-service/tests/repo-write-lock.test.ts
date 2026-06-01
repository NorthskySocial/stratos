import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoWriteLocks } from '../src/shared/repo-write-lock.js'

describe('RepoWriteLocks', () => {
  let locks: RepoWriteLocks

  beforeEach(() => {
    vi.useFakeTimers()
    locks = new RepoWriteLocks()
  })

  afterEach(() => {
    locks.destroy()
    vi.useRealTimers()
  })

  it('acquires and releases a lock for a DID', async () => {
    const unlock = await locks.acquire('did:plc:shinji')
    expect(typeof unlock).toBe('function')
    unlock()
  })

  it('serializes writes for the same DID', async () => {
    const order: string[] = []

    const unlock1 = await locks.acquire('did:plc:asuka')
    order.push('acquired 1')

    const p2 = locks.acquire('did:plc:asuka').then((unlock) => {
      order.push('acquired 2')
      return unlock
    })

    // p2 should be pending
    expect(order).toEqual(['acquired 1'])

    unlock1()
    const unlock2 = await p2
    expect(order).toEqual(['acquired 1', 'acquired 2'])

    unlock2()
  })

  it('allows concurrent writes for different DIDs', async () => {
    const order: string[] = []

    const unlock1 = await locks.acquire('did:plc:rei')
    order.push('acquired rei')

    const unlock2 = await locks.acquire('did:plc:misato')
    order.push('acquired misato')

    expect(order).toEqual(['acquired rei', 'acquired misato'])

    unlock1()
    unlock2()
  })

  it('chains multiple waiters for the same DID', async () => {
    const order: number[] = []

    const unlock1 = await locks.acquire('did:plc:gendo')
    const p2 = locks.acquire('did:plc:gendo').then((u) => {
      order.push(2)
      return u
    })
    const p3 = locks.acquire('did:plc:gendo').then((u) => {
      order.push(3)
      return u
    })

    expect(order).toEqual([])

    unlock1()
    const unlock2 = await p2
    expect(order).toEqual([2])

    unlock2()
    const unlock3 = await p3
    expect(order).toEqual([2, 3])

    unlock3()
  })

  it('does not sweep active locks', async () => {
    const locksMap = (locks as any).locks as Map<string, Promise<void>>

    const unlock1 = await locks.acquire('did:plc:mari')
    expect(locksMap.has('did:plc:mari')).toBe(true)

    // Trigger sweep while lock is held
    ;(locks as any).sweep()

    // Sweep logic involves several microtasks
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }

    expect(locksMap.has('did:plc:mari')).toBe(true)

    unlock1()
  })

  it('stops the sweep timer on destroy', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    locks.destroy()
    expect(clearIntervalSpy).toHaveBeenCalled()
    expect((locks as any).sweepTimer).toBeUndefined()
  })
})
