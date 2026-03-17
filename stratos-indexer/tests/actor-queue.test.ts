import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StratosActorSync } from '../src/stratos-sync.ts'

function createTestSync(
  opts: { maxConcurrentActorSyncs?: number; maxActorQueueSize?: number } = {},
) {
  const errors: Error[] = []
  const cursorManager = {
    getStratosCursor: vi.fn(() => undefined),
    updateStratosCursor: vi.fn(),
    removeStratosCursor: vi.fn(),
  }

  const sync = new StratosActorSync(
    {} as any,
    { stratosServiceUrl: 'ws://localhost', syncToken: 'test' },
    cursorManager as any,
    (err) => errors.push(err),
    undefined,
    {
      maxConcurrentActorSyncs: opts.maxConcurrentActorSyncs ?? 1,
      maxActorQueueSize: opts.maxActorQueueSize ?? 10,
    },
  )

  return { sync, errors, cursorManager }
}

function getPrivate(sync: StratosActorSync, field: string) {
  return (sync as any)[field]
}

function setPrivate(sync: StratosActorSync, field: string, value: unknown) {
  ;(sync as any)[field] = value
}

describe('ActorQueue drain race condition fix', () => {
  let sync: StratosActorSync

  beforeEach(() => {
    ;({ sync } = createTestSync({ maxConcurrentActorSyncs: 1 }))
  })

  it('sets draining flag before awaiting semaphore', async () => {
    const actorQueues: Map<string, any> = getPrivate(sync, 'actorQueues')
    actorQueues.set('did:plc:goku', {
      pending: [new Uint8Array(0)],
      active: false,
      draining: false,
    })

    setPrivate(sync, 'activeSyncs', 1)

    const handleMessage = vi
      .fn()
      .mockResolvedValue(undefined)
    setPrivate(sync, 'handleMessage', handleMessage)

    const drainPromise = (sync as any).drainActorQueue('did:plc:goku')

    await new Promise((r) => setTimeout(r, 10))

    const q = actorQueues.get('did:plc:goku')
    expect(q.draining).toBe(true)
    expect(q.active).toBe(false)

    setPrivate(sync, 'activeSyncs', 0)
    const syncWaiters: Array<() => void> = getPrivate(sync, 'syncWaiters')
    syncWaiters.shift()?.()

    await drainPromise
  })

  it('prevents duplicate drain calls during semaphore wait', async () => {
    const actorQueues: Map<string, any> = getPrivate(sync, 'actorQueues')
    actorQueues.set('did:plc:vegeta', {
      pending: [],
      active: false,
      draining: false,
    })

    setPrivate(sync, 'activeSyncs', 1)
    setPrivate(
      sync,
      'handleMessage',
      vi.fn().mockResolvedValue(undefined),
    )

    actorQueues.get('did:plc:vegeta').pending.push(new Uint8Array(0))
    const drain1 = (sync as any).drainActorQueue('did:plc:vegeta')
    await new Promise((r) => setTimeout(r, 5))

    actorQueues.get('did:plc:vegeta').pending.push(new Uint8Array(0))
    const drain2 = (sync as any).drainActorQueue('did:plc:vegeta')
    await new Promise((r) => setTimeout(r, 5))

    actorQueues.get('did:plc:vegeta').pending.push(new Uint8Array(0))
    const drain3 = (sync as any).drainActorQueue('did:plc:vegeta')

    const syncWaiters: Array<() => void> = getPrivate(sync, 'syncWaiters')
    expect(syncWaiters.length).toBe(1)

    setPrivate(sync, 'activeSyncs', 0)
    syncWaiters.shift()?.()

    await Promise.all([drain1, drain2, drain3])
  })

  it('does not exceed syncWaiters count under rapid message flood', async () => {
    const did = 'did:plc:piccolo'
    const actorQueues: Map<string, any> = getPrivate(sync, 'actorQueues')
    actorQueues.set(did, {
      pending: [],
      active: false,
      draining: false,
    })

    setPrivate(sync, 'activeSyncs', 1)
    setPrivate(
      sync,
      'handleMessage',
      vi.fn().mockResolvedValue(undefined),
    )

    const drainPromises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      actorQueues.get(did).pending.push(new Uint8Array(0))
      drainPromises.push((sync as any).drainActorQueue(did))
    }

    await new Promise((r) => setTimeout(r, 10))

    const syncWaiters: Array<() => void> = getPrivate(sync, 'syncWaiters')
    expect(syncWaiters.length).toBeLessThanOrEqual(1)

    setPrivate(sync, 'activeSyncs', 0)
    syncWaiters.shift()?.()

    await Promise.all(drainPromises)
  })
})

describe('closeAndReconnectActor', () => {
  it('closes WebSocket, clears queue, and schedules reconnect', () => {
    const { sync } = createTestSync()
    const subscriptions: Map<string, any> = getPrivate(sync, 'subscriptions')
    const actorQueues: Map<string, any> = getPrivate(sync, 'actorQueues')

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
    ;(sync as any).closeAndReconnectActor('did:plc:gohan')

    expect(mockWs.close).toHaveBeenCalled()
    expect(subscriptions.has('did:plc:gohan')).toBe(false)
    expect(actorQueues.get('did:plc:gohan').pending).toHaveLength(0)
    expect(scheduleReconnect).toHaveBeenCalledWith('did:plc:gohan')
  })
})

describe('enqueueActorMessage overflow triggers close-and-reconnect', () => {
  it('calls closeAndReconnectActor when queue reaches max size', () => {
    const { sync } = createTestSync({ maxActorQueueSize: 3 })
    const actorQueues: Map<string, any> = getPrivate(sync, 'actorQueues')

    actorQueues.set('did:plc:trunks', {
      pending: [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
      active: false,
      draining: false,
    })

    const closeAndReconnect = vi.fn()
    setPrivate(sync, 'closeAndReconnectActor', closeAndReconnect)
    ;(sync as any).enqueueActorMessage('did:plc:trunks', new Uint8Array(0))

    expect(closeAndReconnect).toHaveBeenCalledWith('did:plc:trunks')
  })
})
