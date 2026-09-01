import { describe, expect, it, vi } from 'vitest'
import {
  SpaceAuthorizationRevokedError,
  SpaceMutationFence,
  type SpaceAuthorizationTarget,
} from '../src/space-sync/index.js'

const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'
const CREW_BOUNDARY = 'did:web:stratos.test/crew'
const CREW_SPACE =
  'at://did:web:stratos.test/space/zone.stratos.space.feed/crew'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function authorize(
  fence: SpaceMutationFence,
): Promise<SpaceAuthorizationTarget> {
  const leases = await fence.authorizeSnapshot({
    boundary: CREW_BOUNDARY,
    spaceUri: CREW_SPACE,
    dids: [SPIKE],
    revocationEpoch: fence.captureRevocationEpoch(),
  })
  return {
    did: SPIKE,
    boundary: CREW_BOUNDARY,
    spaceUri: CREW_SPACE,
    lease: leases.get(SPIKE),
  }
}

describe('SpaceMutationFence', () => {
  it('tracks only active live mutations for the same DID', () => {
    const fence = new SpaceMutationFence()

    fence.beginDidMutation(SPIKE)
    fence.beginDidMutation(SPIKE)
    fence.beginDidMutation(FAYE)

    expect(fence.hasPendingDidMutation(SPIKE)).toBe(true)
    expect(fence.hasPendingDidMutation(FAYE)).toBe(true)
    fence.endDidMutation(SPIKE)
    expect(fence.hasPendingDidMutation(SPIKE)).toBe(true)
    fence.endDidMutation(SPIKE)
    expect(fence.hasPendingDidMutation(SPIKE)).toBe(false)
    expect(fence.hasPendingDidMutation(FAYE)).toBe(true)
    fence.endDidMutation(FAYE)
    expect(fence.hasPendingDidMutation(FAYE)).toBe(false)
  })

  it('settles an aborted queued write before a queued departure purge without resurrecting state', async () => {
    const fence = new SpaceMutationFence()
    const target = await fence.issueRunLease(await authorize(fence))
    const held = deferred<void>()
    const releaseHeld = deferred<void>()
    const holdingScope = fence.withDidScope(SPIKE, async () => {
      held.resolve()
      await releaseHeld.promise
    })
    await held.promise

    let recordPresent = false
    const write = vi.fn(async () => {
      recordPresent = true
    })
    const budget = new AbortController()
    const budgetError = new Error('member budget exhausted')
    const oldWrite = fence.mutate(target, budget.signal, write)
    budget.abort(budgetError)

    const purge = vi.fn(async () => {
      recordPresent = false
    })
    const departure = fence.revokeSpace(SPIKE, CREW_BOUNDARY, CREW_SPACE, purge)

    expect(write).not.toHaveBeenCalled()
    expect(purge).not.toHaveBeenCalled()
    releaseHeld.resolve()
    const [scopeResult, writeResult, departureResult] =
      await Promise.allSettled([holdingScope, oldWrite, departure])

    expect(scopeResult).toEqual({ status: 'fulfilled', value: undefined })
    expect(writeResult).toEqual({ status: 'rejected', reason: budgetError })
    expect(departureResult).toEqual({ status: 'fulfilled', value: undefined })
    expect(write).not.toHaveBeenCalled()
    expect(purge).toHaveBeenCalledOnce()
    expect(recordPresent).toBe(false)
  })

  it('rotates run generations so a late old invalid-commit revoke cannot purge a newer run', async () => {
    const fence = new SpaceMutationFence()
    const membershipTarget = await authorize(fence)
    const oldRun = await fence.issueRunLease(membershipTarget)
    await fence.mutate(oldRun, undefined, async () => {})

    const newerRun = await fence.issueRunLease(membershipTarget)
    await fence.mutate(newerRun, undefined, async () => {})

    expect(newerRun.lease?.runGeneration).toBeGreaterThan(
      oldRun.lease?.runGeneration ?? 0,
    )
    const purge = vi.fn(async () => {})
    await expect(fence.revokeSpaceForRun(oldRun, purge)).rejects.toBeInstanceOf(
      SpaceAuthorizationRevokedError,
    )
    expect(purge).not.toHaveBeenCalled()

    const newerWrite = vi.fn(async () => {})
    await expect(
      fence.mutate(newerRun, undefined, newerWrite),
    ).resolves.toBeUndefined()
    expect(newerWrite).toHaveBeenCalledOnce()
  })

  it('does not authorize a stale enumeration epoch captured before revocation', async () => {
    const fence = new SpaceMutationFence()
    const staleEpoch = fence.captureRevocationEpoch()

    const purge = vi.fn(async () => {})
    await fence.revokeSpace(SPIKE, CREW_BOUNDARY, CREW_SPACE, purge)

    const staleLeases = await fence.authorizeSnapshot({
      boundary: CREW_BOUNDARY,
      spaceUri: CREW_SPACE,
      dids: [SPIKE],
      revocationEpoch: staleEpoch,
    })
    expect(staleLeases.has(SPIKE)).toBe(false)

    const freshLeases = await fence.authorizeSnapshot({
      boundary: CREW_BOUNDARY,
      spaceUri: CREW_SPACE,
      dids: [SPIKE],
      revocationEpoch: fence.captureRevocationEpoch(),
    })
    expect(freshLeases.get(SPIKE)).toMatchObject({
      did: SPIKE,
      spaceUri: CREW_SPACE,
    })
  })

  it('rejects authorization queued before a concurrent revocation commits', async () => {
    const fence = new SpaceMutationFence()
    const scopeHeld = deferred<void>()
    const releaseScope = deferred<void>()
    const holdingScope = fence.withDidScope(SPIKE, async () => {
      scopeHeld.resolve()
      await releaseScope.promise
    })
    await scopeHeld.promise

    const authorizing = fence.authorizeSnapshot({
      boundary: CREW_BOUNDARY,
      spaceUri: CREW_SPACE,
      dids: [SPIKE],
      revocationEpoch: fence.captureRevocationEpoch(),
    })
    // Let authorization enqueue its DID-scoped commit behind the held scope.
    await Promise.resolve()

    const purge = vi.fn(async () => {})
    const revoking = fence.revokeSpace(SPIKE, CREW_BOUNDARY, CREW_SPACE, purge)
    releaseScope.resolve()

    const [leases] = await Promise.all([authorizing, revoking, holdingScope])
    expect(leases.has(SPIKE)).toBe(false)
    expect(purge).toHaveBeenCalledOnce()
  })
})
