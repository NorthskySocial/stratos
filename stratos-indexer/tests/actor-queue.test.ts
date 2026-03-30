import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CursorManager } from '../src/index.ts'
import { StratosActorSync, StratosActorSyncOptions } from '../src/index.ts'

interface ActorQueue {
  pending: Uint8Array[]
  active: boolean
  draining: boolean
}

function createTestSync(opts: Partial<StratosActorSyncOptions> = {}) {
  const errors: Error[] = []
  const cursorManager = {
    getStratosCursor: vi.fn(() => undefined),
    updateStratosCursor: vi.fn(),
    removeStratosCursor: vi.fn(),
  }

  const sync = new StratosActorSync(
    {} as unknown as ConstructorParameters<typeof StratosActorSync>[0],
    { stratosServiceUrl: 'ws://localhost', syncToken: 'test' },
    cursorManager as unknown as CursorManager,
    (err) => errors.push(err),
    undefined,
    opts,
  )

  return { sync, errors, cursorManager }
}

function getPrivate(sync: StratosActorSync, field: string) {
  return (sync as unknown as Record<string, unknown>)[field]
}

function setPrivate(sync: StratosActorSync, field: string, value: unknown) {
  ;(sync as unknown as Record<string, unknown>)[field] = value
}

describe('ActorQueue drain race condition fix', () => {
  let sync: StratosActorSync

  beforeEach(() => {
    ;({ sync } = createTestSync({ maxConcurrentActorSyncs: 1 }))
  })

  it('sets draining flag, prevents duplicate drains, and caps syncWaiters under flood', async () => {
    const actorQueues = getPrivate(sync, 'actorQueues') as Map<
      string,
      ActorQueue
    >
    actorQueues.set('did:plc:goku', {
      pending: [new Uint8Array(0)],
      active: false,
      draining: false,
    })

    setPrivate(sync, 'activeSyncs', 1)
    setPrivate(sync, 'handleMessage', vi.fn().mockResolvedValue(undefined))

    const drainFn = getPrivate(sync, 'drainActorQueue') as (
      did: string,
    ) => Promise<void>

    // First drain: should set draining flag while waiting on semaphore
    const drain1 = drainFn.call(sync, 'did:plc:goku')
    await new Promise((r) => setTimeout(r, 10))

    const q = actorQueues.get('did:plc:goku')!
    expect(q.draining).toBe(true)
    expect(q.active).toBe(false)

    // Duplicate drains should not add extra syncWaiters
    q.pending.push(new Uint8Array(0))
    const drain2 = drainFn.call(sync, 'did:plc:goku')
    q.pending.push(new Uint8Array(0))
    const drain3 = drainFn.call(sync, 'did:plc:goku')

    await new Promise((r) => setTimeout(r, 5))
    const syncWaiters = getPrivate(sync, 'syncWaiters') as Array<() => void>
    expect(syncWaiters.length).toBeLessThanOrEqual(1)

    // Flood: 100 rapid drains should still cap at 1 waiter
    for (let i = 0; i < 100; i++) {
      q.pending.push(new Uint8Array(0))
      drainFn.call(sync, 'did:plc:goku')
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(syncWaiters.length).toBeLessThanOrEqual(1)

    // Unblock semaphore and let all drains complete
    setPrivate(sync, 'activeSyncs', 0)
    syncWaiters.shift()?.()

    await Promise.all([drain1, drain2, drain3])
  })
})

describe('closeAndReconnectActor', () => {
  it('closes WebSocket, clears queue, and schedules reconnect', () => {
    const { sync } = createTestSync()
    const subscriptions = getPrivate(sync, 'subscriptions') as Map<
      string,
      { close: ReturnType<typeof vi.fn> }
    >
    const actorQueues = getPrivate(sync, 'actorQueues') as Map<
      string,
      ActorQueue
    >

    const mockWs = { close: vi.fn() }
    subscriptions.set('did:plc:gohan', mockWs)
    actorQueues.set('did:plc:gohan', {
      pending: [new Uint8Array(1), new Uint8Array(2)],
      active: false,
      draining: false,
    })

    setPrivate(sync, 'running', true)
    const scheduleReconnect = vi.fn()
    setPrivate(sync, 'scheduleReconnect', scheduleReconnect)
    const closeAndReconnectActor = getPrivate(
      sync,
      'closeAndReconnectActor',
    ) as (did: string) => void
    closeAndReconnectActor.call(sync, 'did:plc:gohan')

    expect(mockWs.close).toHaveBeenCalled()
    expect(subscriptions.has('did:plc:gohan')).toBe(false)
    expect(actorQueues.get('did:plc:gohan')?.pending).toHaveLength(0)
    expect(scheduleReconnect).toHaveBeenCalledWith('did:plc:gohan')
  })
})

describe('enqueueActorMessage overflow triggers close-and-reconnect', () => {
  it('calls closeAndReconnectActor when queue reaches max size', () => {
    const { sync } = createTestSync({ maxActorQueueSize: 3 })
    const actorQueues = getPrivate(sync, 'actorQueues') as Map<
      string,
      ActorQueue
    >

    actorQueues.set('did:plc:trunks', {
      pending: [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
      active: false,
      draining: false,
    })

    const closeAndReconnect = vi.fn()
    setPrivate(sync, 'closeAndReconnectActor', closeAndReconnect)
    const enqueueActorMessage = getPrivate(sync, 'enqueueActorMessage') as (
      did: string,
      data: Uint8Array,
    ) => void
    enqueueActorMessage.call(sync, 'did:plc:trunks', new Uint8Array(0))

    expect(closeAndReconnect).toHaveBeenCalledWith('did:plc:trunks')
  })

  it('calls closeAndReconnectActor when global pending count exceeds cap', () => {
    const { sync } = createTestSync({
      maxActorQueueSize: 100,
      globalMaxPending: 5,
    })

    setPrivate(sync, 'globalPendingCount', 5)

    const closeAndReconnect = vi.fn()
    setPrivate(sync, 'closeAndReconnectActor', closeAndReconnect)
    const enqueueActorMessage = getPrivate(sync, 'enqueueActorMessage') as (
      did: string,
      data: Uint8Array,
    ) => void
    enqueueActorMessage.call(sync, 'did:plc:bulma', new Uint8Array(0))

    expect(closeAndReconnect).toHaveBeenCalledWith('did:plc:bulma')
  })
})

describe('globalPendingCount tracking', () => {
  it('increments on enqueue and decrements on drain', async () => {
    const { sync } = createTestSync({
      maxConcurrentActorSyncs: 1,
      globalMaxPending: 500,
      drainDelayMs: 0,
    })

    setPrivate(sync, 'handleMessage', vi.fn().mockResolvedValue(undefined))

    // Block drains by saturating the semaphore
    setPrivate(sync, 'activeSyncs', 1)
    const enqueueActorMessage = getPrivate(sync, 'enqueueActorMessage') as (
      did: string,
      data: Uint8Array,
    ) => void
    enqueueActorMessage.call(sync, 'did:plc:krillin', new Uint8Array(0))
    enqueueActorMessage.call(sync, 'did:plc:krillin', new Uint8Array(0))
    enqueueActorMessage.call(sync, 'did:plc:yamcha', new Uint8Array(0))

    // Messages queued but not drained due to semaphore
    expect(getPrivate(sync, 'globalPendingCount')).toBe(3)

    // Unblock drains
    setPrivate(sync, 'activeSyncs', 0)
    const syncWaiters = getPrivate(sync, 'syncWaiters') as Array<() => void>
    while (syncWaiters.length > 0) syncWaiters.shift()?.()

    await new Promise((r) => setTimeout(r, 50))

    expect(getPrivate(sync, 'globalPendingCount')).toBe(0)
  })
})

describe('drain delay throttles processing', () => {
  it('introduces delay between messages when drainDelayMs > 0', async () => {
    const { sync } = createTestSync({
      maxConcurrentActorSyncs: 10,
      drainDelayMs: 20,
    })

    const callTimestamps: number[] = []
    setPrivate(
      sync,
      'handleMessage',
      vi.fn(async () => {
        callTimestamps.push(Date.now())
      }),
    )

    const actorQueues = getPrivate(sync, 'actorQueues') as Map<
      string,
      ActorQueue
    >
    actorQueues.set('did:plc:tien', {
      pending: [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
      active: false,
      draining: false,
    })
    setPrivate(sync, 'globalPendingCount', 3)

    const drainFn = getPrivate(sync, 'drainActorQueue') as (
      did: string,
    ) => Promise<void>
    await drainFn.call(sync, 'did:plc:tien')

    expect(callTimestamps).toHaveLength(3)
    const gap1 = callTimestamps[1] - callTimestamps[0]
    const gap2 = callTimestamps[2] - callTimestamps[1]
    expect(gap1).toBeGreaterThanOrEqual(15)
    expect(gap2).toBeGreaterThanOrEqual(15)
  })
})
