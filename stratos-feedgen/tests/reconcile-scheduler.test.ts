import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconcileScheduler } from '../src/purge/index.js'
import { FeedReadinessGate } from '../src/readiness.js'

function makeControlledRun(): {
  run: () => Promise<boolean>
  starts: number
  finish: () => void
} {
  const state = {
    run: async () => true,
    starts: 0,
    finish: () => {},
    pending: [] as Array<() => void>,
  }
  state.run = () => {
    state.starts++
    return new Promise<boolean>((resolve) =>
      state.pending.push(() => resolve(true)),
    )
  }
  state.finish = () => {
    state.pending.shift()?.()
  }
  return state
}

describe('createReconcileScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('awaits the initial pass without requiring readiness before startup continues', async () => {
    let finish!: (ready: boolean) => void
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const trigger = createReconcileScheduler(run)
    const initialized = vi.fn()
    const starting = trigger.initialize().then(initialized)
    await vi.advanceTimersByTimeAsync(0)
    expect(initialized).not.toHaveBeenCalled()
    finish(false)
    await starting
    expect(initialized).toHaveBeenCalledExactlyOnceWith(true)
    await trigger.stop()
  })

  it('shares an active pass with initialization and still coalesces reconnects', async () => {
    const ctl = makeControlledRun()
    const trigger = createReconcileScheduler(ctl.run)
    trigger()
    const starting = trigger.initialize()
    trigger()
    expect(ctl.starts).toBe(1)
    ctl.finish()
    expect(await starting).toBe(true)
    expect(ctl.starts).toBe(2)
    ctl.finish()
    await trigger.stop()
  })

  it('propagates initial failures to startup', async () => {
    const error = new Error('NERV store unavailable')
    const trigger = createReconcileScheduler(async () => {
      throw error
    })
    await expect(trigger.initialize()).rejects.toBe(error)
    await trigger.stop()
  })

  it('drains a cancelled initial pass without continuing startup or reporting a background error', async () => {
    let signal!: AbortSignal
    const run = vi.fn((current: AbortSignal) => {
      signal = current
      return new Promise<boolean>((_resolve, reject) => {
        current.addEventListener('abort', () => reject(current.reason), {
          once: true,
        })
      })
    })
    const onError = vi.fn()
    const trigger = createReconcileScheduler(run, onError)
    const starting = trigger.initialize()
    const stopping = trigger.stop()
    expect(signal.aborted).toBe(false)
    trigger.abortActivePass()
    expect(signal.aborted).toBe(true)
    expect(await starting).toBe(false)
    await stopping
    expect(await trigger.initialize()).toBe(false)
    trigger()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => trigger.abortActivePass()).not.toThrow()
  })

  it('ignores expected cancellation errors from a stopped background pass', async () => {
    const onError = vi.fn()
    const trigger = createReconcileScheduler(
      (signal) =>
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        }),
      onError,
    )
    trigger()
    const stopping = trigger.stop()
    trigger.abortActivePass()
    await stopping
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries incomplete reconciliation without a reconnect and releases the gate', async () => {
    const gate = new FeedReadinessGate()
    gate.markSessionEstablished()
    const outcomes = [
      { errors: 36, truncated: false },
      { errors: 0, truncated: true },
      { errors: 0, truncated: false },
    ]
    const run = vi.fn(async () =>
      gate.completeReconciliation(
        gate.beginReconciliation(),
        outcomes.shift()!,
      ),
    )
    const trigger = createReconcileScheduler(run)
    trigger()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(run).toHaveBeenCalledTimes(1)
    expect(gate.isReady()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(gate.isReady()).toBe(false)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    expect(gate.isReady()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(3)
    await trigger.stop()
  })

  it('caps exponential backoff at 60 seconds and resets it after success', async () => {
    const run = vi.fn(async () => false)
    const trigger = createReconcileScheduler(run)
    trigger()
    let calls = 1
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(run).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(++calls)
    }
    run.mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(60_000)
    calls++
    trigger()
    calls++
    await vi.advanceTimersByTimeAsync(4_999)
    expect(run).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(calls + 1)
    await trigger.stop()
  })

  it('retries rejected runs and reports the error', async () => {
    const error = new Error('NERV authority unavailable')
    const run = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(true)
    const onError = vi.fn()
    const trigger = createReconcileScheduler(run, onError)
    trigger()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(run).toHaveBeenCalledTimes(2)
    await trigger.stop()
  })

  it('recovers if a run throws before returning its promise', async () => {
    const error = new Error('Bebop connection unavailable')
    const run = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockResolvedValue(true)
    const onError = vi.fn()
    const trigger = createReconcileScheduler(run, onError)
    trigger()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onError).toHaveBeenCalledExactlyOnceWith(error)
    expect(run).toHaveBeenCalledTimes(2)
    await trigger.stop()
  })

  it('reconnects immediately and cancels an older retry timer', async () => {
    const run = vi.fn(async () => false)
    const trigger = createReconcileScheduler(run)
    trigger()
    await vi.advanceTimersByTimeAsync(1_000)
    trigger()
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    await trigger.stop()
  })

  it('cancels pending retries on stop and ignores later triggers', async () => {
    const run = vi.fn(async () => false)
    const trigger = createReconcileScheduler(run)
    trigger()
    await vi.advanceTimersByTimeAsync(0)
    await trigger.stop()
    trigger()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, 2])(
    'drains the active run on stop with %i queued triggers',
    async (queuedTriggers) => {
      let finish!: (released: boolean) => void
      const run = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve
          }),
      )
      const trigger = createReconcileScheduler(run)
      trigger()
      for (let i = 0; i < queuedTriggers; i++) trigger()
      const stopped = vi.fn()
      const stopping = trigger.stop().then(stopped)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(stopped).not.toHaveBeenCalled()
      expect(run).toHaveBeenCalledTimes(1)
      finish(false)
      await stopping
      expect(stopped).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(run).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
  it('runs immediately when idle', async () => {
    const ctl = makeControlledRun()
    const trigger = createReconcileScheduler(ctl.run)
    trigger()
    expect(ctl.starts).toBe(1)
    ctl.finish()
    // Let the run's completion settle so the scheduler is idle again.
    await vi.advanceTimersByTimeAsync(0)
    trigger()
    expect(ctl.starts).toBe(2)
    ctl.finish()
  })

  it('coalesces triggers during an in-flight run into exactly one follow-up', async () => {
    const ctl = makeControlledRun()
    const trigger = createReconcileScheduler(ctl.run)
    trigger()
    expect(ctl.starts).toBe(1)

    // A burst of reconnects while the run is still in flight.
    trigger()
    trigger()
    trigger()
    expect(ctl.starts).toBe(1)

    ctl.finish()
    await vi.waitFor(() => expect(ctl.starts).toBe(2))
    ctl.finish()

    // No third run: the burst coalesced into the single follow-up.
    await vi.advanceTimersByTimeAsync(10)
    expect(ctl.starts).toBe(2)
  })

  it('reports a rejected run via onError instead of throwing', async () => {
    const errors: Error[] = []
    const trigger = createReconcileScheduler(
      async () => {
        throw new Error('upstream unreachable')
      },
      (err) => errors.push(err),
    )
    expect(() => trigger()).not.toThrow()
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0].message).toBe('upstream unreachable')

    // A rejection must not wedge the scheduler: the next trigger runs again.
    trigger()
    await vi.waitFor(() => expect(errors).toHaveLength(2))
  })

  it('still runs the coalesced follow-up after the in-flight run rejects', async () => {
    const errors: Error[] = []
    let calls = 0
    const first: { reject: ((err: Error) => void) | null } = { reject: null }
    const trigger = createReconcileScheduler(
      () => {
        calls++
        if (calls === 1) {
          return new Promise<boolean>((_resolve, reject) => {
            first.reject = reject
          })
        }
        return Promise.resolve(true)
      },
      (err) => errors.push(err),
    )
    trigger()
    trigger()
    expect(calls).toBe(1)
    first.reject?.(new Error('mid-run failure'))
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(errors.map((e) => e.message)).toEqual(['mid-run failure'])
  })
})
