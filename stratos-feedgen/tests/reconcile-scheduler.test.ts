import { describe, expect, it, vi } from 'vitest'
import { createReconcileScheduler } from '../src/purge/index.js'

function makeControlledRun(): {
  run: () => Promise<void>
  starts: number
  finish: () => void
} {
  const state = {
    run: async () => {},
    starts: 0,
    finish: () => {},
    pending: [] as Array<() => void>,
  }
  state.run = () => {
    state.starts++
    return new Promise<void>((resolve) => state.pending.push(resolve))
  }
  state.finish = () => {
    state.pending.shift()?.()
  }
  return state
}

describe('createReconcileScheduler', () => {
  it('runs immediately when idle', async () => {
    const ctl = makeControlledRun()
    const trigger = createReconcileScheduler(ctl.run)
    trigger()
    expect(ctl.starts).toBe(1)
    ctl.finish()
    // Let the run's completion settle so the scheduler is idle again.
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    await new Promise((resolve) => setTimeout(resolve, 10))
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
          return new Promise<void>((_resolve, reject) => {
            first.reject = reject
          })
        }
        return Promise.resolve()
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
