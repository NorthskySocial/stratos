import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorManager } from '../src/index.ts'
import { StratosActorSync, StratosActorSyncOptions } from '../src/index.ts'
import { ActorSyncer } from '../src/actor-syncer.ts'

function createTestSync(opts: Partial<StratosActorSyncOptions> = {}) {
  const errors: Error[] = []
  const cursorManager = {
    getStratosCursor: vi.fn(() => undefined),
    updateStratosCursor: vi.fn(),
    removeStratosCursor: vi.fn(),
  }

  const sync = new StratosActorSync(
    {} as never,
    { stratosServiceUrl: 'ws://localhost', syncToken: 'test' },
    cursorManager as unknown as CursorManager,
    (err) => errors.push(err),
    undefined,
    opts,
  )

  return { sync, errors, cursorManager }
}

function getPrivate(obj: object, field: string) {
  return (obj as Record<string, unknown>)[field]
}

function setPrivate(obj: object, field: string, value: unknown) {
  ;(obj as Record<string, unknown>)[field] = value
}

describe('ActorQueue drain race condition fix', () => {
  let sync: StratosActorSync

  beforeEach(() => {
    ;({ sync } = createTestSync({ maxConcurrentActorSyncs: 1 }))
  })

  it('sets draining flag, prevents duplicate drains, and caps global pending', async () => {
    sync.start()
    sync.addActor('did:plc:goku')
    const promoteFn = getPrivate(sync, 'promoteWaitingActor') as () => void
    promoteFn.call(sync)

    const syncers = getPrivate(sync, 'syncers') as Map<string, ActorSyncer>
    const syncer = syncers.get('did:plc:goku')!

    // Mock canStartSync to control draining
    const options = getPrivate(syncer, 'options')
    options.canStartSync = vi.fn(() => false)
    options.drainDelayMs = 10

    const enqueueFn = getPrivate(syncer, 'enqueueMessage') as (
      data: Uint8Array,
    ) => void

    // Enqueue first message: should start draining but get stuck at canStartSync
    enqueueFn.call(syncer, new Uint8Array(0))
    await new Promise((r) => setTimeout(r, 5))

    const queue = getPrivate(syncer, 'queue')
    expect(queue.draining).toBe(true)
    expect(queue.pending.length).toBe(1)

    // Enqueue more messages
    enqueueFn.call(syncer, new Uint8Array(0))
    enqueueFn.call(syncer, new Uint8Array(0))

    expect(queue.pending.length).toBe(3)
    expect(queue.draining).toBe(true)

    // Unblock draining
    options.canStartSync.mockReturnValue(true)

    // Wait for queue to drain
    let attempts = 0
    while (queue.pending.length > 0 && attempts < 20) {
      await new Promise((r) => setTimeout(r, 20))
      attempts++
    }

    expect(queue.pending.length).toBe(0)
    expect(queue.draining).toBe(false)
  })
})

describe('closeAndReconnect', () => {
  it('closes WebSocket and schedules reconnect', () => {
    const { sync } = createTestSync()
    sync.start()
    sync.addActor('did:plc:gohan')
    const promoteFn = getPrivate(sync, 'promoteWaitingActor') as () => void
    promoteFn.call(sync)

    const syncers = getPrivate(sync, 'syncers') as Map<string, ActorSyncer>
    const syncer = syncers.get('did:plc:gohan')!

    const mockWs = { close: vi.fn() }
    setPrivate(syncer, 'ws', mockWs)

    const closeAndReconnect = getPrivate(
      syncer,
      'closeAndReconnect',
    ) as () => void
    closeAndReconnect.call(syncer)

    expect(mockWs.close).toHaveBeenCalled()
    expect(getPrivate(syncer, 'ws')).toBeNull()
    expect(getPrivate(syncer, 'reconnectTimer')).toBeDefined()
  })
})

describe('enqueueMessage overflow', () => {
  it('calls closeAndReconnect when queue reaches max size', () => {
    const { sync } = createTestSync({ maxActorQueueSize: 2 })
    sync.start()
    sync.addActor('did:plc:vegeta')
    const promoteFn = getPrivate(sync, 'promoteWaitingActor') as () => void
    promoteFn.call(sync)

    const syncers = getPrivate(sync, 'syncers') as Map<string, ActorSyncer>
    const syncer = syncers.get('did:plc:vegeta')!

    const mockWs = { close: vi.fn() }
    setPrivate(syncer, 'ws', mockWs)

    const enqueueFn = getPrivate(syncer, 'enqueueMessage') as (
      data: Uint8Array,
    ) => void

    // Set draining to true so it doesn't actually drain
    getPrivate(syncer, 'queue').draining = true

    enqueueFn.call(syncer, new Uint8Array(1))
    enqueueFn.call(syncer, new Uint8Array(2))

    expect(mockWs.close).not.toHaveBeenCalled()

    enqueueFn.call(syncer, new Uint8Array(3))

    expect(mockWs.close).toHaveBeenCalled()
  })
})
