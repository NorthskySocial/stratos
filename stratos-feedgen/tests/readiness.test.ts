import { describe, expect, it } from 'vitest'

import { FeedReadinessGate } from '../src/readiness.js'

describe('FeedReadinessGate', () => {
  it('starts unavailable until a stream session completes reconciliation', () => {
    const gate = new FeedReadinessGate()

    expect(gate.isReady()).toBe(false)

    const beforeSession = gate.beginReconciliation()
    expect(
      gate.completeReconciliation(beforeSession, {
        errors: 0,
        truncated: false,
      }),
    ).toBe(false)
    expect(gate.isReady()).toBe(false)

    gate.markSessionEstablished()
    const afterSession = gate.beginReconciliation()
    expect(
      gate.completeReconciliation(afterSession, {
        errors: 0,
        truncated: false,
      }),
    ).toBe(true)
    expect(gate.isReady()).toBe(true)

    gate.markUnavailable()
    expect(gate.isReady()).toBe(false)
  })

  it('does not release after incomplete or superseded reconciliation', () => {
    const gate = new FeedReadinessGate()
    gate.markSessionEstablished()

    const failed = gate.beginReconciliation()
    expect(
      gate.completeReconciliation(failed, { errors: 1, truncated: false }),
    ).toBe(false)
    expect(gate.isReady()).toBe(false)

    const partial = gate.beginReconciliation()
    expect(
      gate.completeReconciliation(partial, { errors: 0, truncated: true }),
    ).toBe(false)
    expect(gate.isReady()).toBe(false)

    const olderGeneration = gate.beginReconciliation()
    gate.markUnavailable()
    expect(
      gate.completeReconciliation(olderGeneration, {
        errors: 0,
        truncated: false,
      }),
    ).toBe(false)
    expect(gate.isReady()).toBe(false)
  })
})
