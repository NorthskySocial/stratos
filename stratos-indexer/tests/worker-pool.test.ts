import { beforeEach, describe, expect, it } from 'vitest'
import { WorkerPool } from '../src/index.ts'

describe('WorkerPool', () => {
  let errors: Error[]
  let onError: (err: Error) => void

  beforeEach(() => {
    errors = []
    onError = (err) => errors.push(err)
  })

  it('executes submitted tasks', async () => {
    const processed: string[] = []
    const pool = new WorkerPool<string>(
      2,
      10,
      async (data) => {
        processed.push(data)
      },
      onError,
    )

    await pool.submit('goku')
    await pool.submit('vegeta')
    await pool.stop()

    expect(processed).toContain('goku')
    expect(processed).toContain('vegeta')
    expect(errors).toHaveLength(0)
  })

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const pool = new WorkerPool<number>(
      2,
      10,
      async () => {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        await new Promise((r) => setTimeout(r, 50))
        currentConcurrent--
      },
      onError,
    )

    const promises = Array.from({ length: 6 }, (_, i) => pool.submit(i))
    await Promise.all(promises)
    await pool.stop()

    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('calls onError for handler failures without rejecting submit', async () => {
    const pool = new WorkerPool<string>(
      1,
      10,
      async (data) => {
        if (data === 'fail') throw new Error('kamehameha failed')
      },
      onError,
    )

    await pool.submit('fail')
    await pool.stop()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('kamehameha failed')
  })

  it('throws when submitting to a stopped pool', async () => {
    const pool = new WorkerPool<string>(1, 10, async () => {}, onError)
    await pool.stop()

    await expect(pool.submit('naruto')).rejects.toThrow(
      'worker pool is stopped',
    )
  })

  it('applies backpressure when queue is full', async () => {
    const resolver: Array<() => void> = []
    const pool = new WorkerPool<number>(
      1,
      2,
      async () => {
        await new Promise<void>((r) => resolver.push(r))
      },
      onError,
    )

    // 1 active + 2 queued fills the pool
    void pool.submit(1)
    void pool.submit(2)
    void pool.submit(3)

    await new Promise((r) => setTimeout(r, 20))

    // submit(4) should block — verify queue is at capacity
    let p4started = false
    const p4 = pool.submit(4).then(() => {
      p4started = true
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(p4started).toBe(false)

    // Release tasks one at a time to unblock
    resolver[0]()
    await new Promise((r) => setTimeout(r, 50))
    resolver[1]?.()
    await new Promise((r) => setTimeout(r, 50))
    resolver[2]?.()
    await new Promise((r) => setTimeout(r, 50))
    resolver[3]?.()

    await p4
    await pool.stop()

    expect(p4started).toBe(true)
  })

  it('reports pendingCount and runningCount', async () => {
    const resolver: Array<() => void> = []
    const pool = new WorkerPool<number>(
      1,
      10,
      async () => {
        await new Promise<void>((r) => resolver.push(r))
      },
      onError,
    )

    void pool.submit(1)
    void pool.submit(2)
    void pool.submit(3)

    await new Promise((r) => setTimeout(r, 20))

    expect(pool.runningCount).toBe(1)
    expect(pool.pendingCount).toBe(2)

    // Release all
    while (resolver.length < 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    for (const r of resolver) r()
    await new Promise((r) => setTimeout(r, 20))

    while (resolver.length < 2) {
      await new Promise((r) => setTimeout(r, 10))
    }
    for (const r of resolver) r()
    await new Promise((r) => setTimeout(r, 20))

    while (resolver.length < 3) {
      await new Promise((r) => setTimeout(r, 10))
    }
    for (const r of resolver) r()

    await pool.stop()
  })
})
