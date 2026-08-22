import { StratosError } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CursorManager } from '../src/index.js'
import { StratosServiceSubscription } from '../src/index.js'
import { StratosActorSync } from '../src/sync/stratos-sync.js'

const SERVICE_STREAM_MAX_QUEUE = 1_000

const ACTORS = ['did:plc:motoko', 'did:plc:batou', 'did:plc:togusa']

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onerror: ((e: Event & { error?: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn(() => {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  })
  private openListeners: Array<() => void> = []

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: () => void): void {
    if (type === 'open') this.openListeners.push(cb)
  }

  open(): void {
    this.readyState = 1
    for (const cb of this.openListeners) cb()
  }

  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer as ArrayBuffer })
  }
}

/** A frame the stubbed handler can identify by its actor index. */
function frameFor(actorIndex: number): Uint8Array {
  return new Uint8Array([actorIndex])
}

function createSubscription() {
  const errors: Error[] = []
  const subscription = new StratosServiceSubscription(
    { stratosServiceUrl: 'http://localhost:2583', syncToken: 'lain-navi' },
    { onEnroll: vi.fn(), onUnenroll: vi.fn() },
    (err) => errors.push(err),
  )
  return { subscription, errors }
}

/** Replace the frame handler so a test can control when a frame finishes. */
function stubHandler(
  subscription: StratosServiceSubscription,
  handler: (data: Uint8Array) => Promise<void>,
): void {
  ;(subscription as unknown as Record<string, unknown>).handleMessage = handler
}

function pendingFrames(subscription: StratosServiceSubscription): Uint8Array[] {
  const queue = (subscription as unknown as Record<string, unknown>).queue as {
    pending: Uint8Array[]
  }
  return queue.pending
}

describe('StratosServiceSubscription enrollment stream', () => {
  let originalWebSocket: typeof globalThis.WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('applies frames in arrival order even when earlier frames are slower', async () => {
    const { subscription } = createSubscription()
    const applied: string[] = []
    const handlerDelaysMs = [30, 10, 0]

    stubHandler(subscription, async (data) => {
      const actorIndex = data[0]
      await new Promise((resolve) =>
        setTimeout(resolve, handlerDelaysMs[actorIndex]),
      )
      applied.push(ACTORS[actorIndex])
    })

    subscription.start()
    const socket = FakeWebSocket.instances[0]
    for (let i = 0; i < ACTORS.length; i++) {
      socket.deliver(frameFor(i))
    }

    await vi.waitFor(() => expect(applied).toHaveLength(ACTORS.length))
    expect(applied).toEqual(ACTORS)

    subscription.stop()
  })

  it('does not start a frame before the previous one settles', async () => {
    const { subscription } = createSubscription()
    const started: number[] = []
    const finished: number[] = []
    let releaseFirst: (() => void) | undefined

    stubHandler(subscription, async (data) => {
      const actorIndex = data[0]
      started.push(actorIndex)
      if (actorIndex === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      finished.push(actorIndex)
    })

    subscription.start()
    const socket = FakeWebSocket.instances[0]
    socket.deliver(frameFor(0))
    socket.deliver(frameFor(1))
    await Promise.resolve()

    expect(started).toEqual([0])
    expect(finished).toEqual([])

    releaseFirst?.()
    await vi.waitFor(() => expect(finished).toHaveLength(2))
    expect(started).toEqual([0, 1])
    expect(finished).toEqual([0, 1])

    subscription.stop()
  })

  it('drops the queue and closes the socket on overflow', async () => {
    vi.useFakeTimers()
    const { subscription, errors } = createSubscription()
    stubHandler(subscription, () => new Promise<void>(() => {}))

    subscription.start()
    const socket = FakeWebSocket.instances[0]

    // The first frame is shifted into the stalled handler; the rest pile up.
    for (let i = 0; i <= SERVICE_STREAM_MAX_QUEUE; i++) {
      socket.deliver(frameFor(0))
    }
    await Promise.resolve()
    expect(pendingFrames(subscription)).toHaveLength(SERVICE_STREAM_MAX_QUEUE)
    expect(errors).toHaveLength(0)
    expect(socket.close).not.toHaveBeenCalled()

    socket.deliver(frameFor(1))

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(StratosError)
    expect((errors[0] as StratosError).code).toBe('SERVICE_STREAM_OVERFLOW')
    expect(socket.close).toHaveBeenCalled()
    expect(pendingFrames(subscription)).toHaveLength(0)

    // The service-level reconnect is uncapped, so the stream resumes.
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)

    subscription.stop()
  })

  it('ignores a late close event from a replaced socket', () => {
    vi.useFakeTimers()
    const { subscription } = createSubscription()
    stubHandler(subscription, () => new Promise<void>(() => {}))

    subscription.start()
    const staleSocket = FakeWebSocket.instances[0]
    // A real socket delivers its close event asynchronously. Detach the
    // callback so stop() cannot fire it, then fire it late by hand.
    const staleClose = staleSocket.onclose
    staleSocket.onclose = null

    subscription.stop()
    subscription.start()
    const activeSocket = FakeWebSocket.instances[1]
    activeSocket.open()

    // The first frame is shifted into the stalled handler; one stays pending.
    activeSocket.deliver(frameFor(0))
    activeSocket.deliver(frameFor(1))
    expect(pendingFrames(subscription)).toHaveLength(1)

    staleClose?.()

    // The active socket, its queue, and the timer set must be untouched.
    expect(subscription.isConnected()).toBe(true)
    expect(pendingFrames(subscription)).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    subscription.stop()
  })
})

describe('StratosActorSync idle eviction', () => {
  let originalWebSocket: typeof globalThis.WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  function createActorSync() {
    const cursorManager = {
      getStratosCursor: vi.fn(() => undefined),
      updateStratosCursor: vi.fn(),
      removeStratosCursor: vi.fn(),
    } as unknown as CursorManager

    return new StratosActorSync(
      {} as never,
      { stratosServiceUrl: 'http://localhost:2583', syncToken: 'lain-navi' },
      cursorManager,
      () => {},
      undefined,
      {
        maxConnections: 2,
        connectDelayMs: 1,
        idleEvictionMs: 100,
        reconnectBaseDelayMs: 1,
        reconnectMaxDelayMs: 1,
        reconnectJitterMs: 0,
        reconnectMaxAttempts: 1,
        reconnectCooldownMs: 300_000,
      },
    )
  }

  it('spares a cooling syncer and evicts a genuinely idle one instead', () => {
    const sync = createActorSync()
    sync.start()

    // Fill both connection slots, then queue a waiter to arm eviction.
    sync.addActor('did:plc:motoko')
    vi.advanceTimersByTime(1)
    sync.addActor('did:plc:batou')
    vi.advanceTimersByTime(1)
    sync.addActor('did:plc:togusa')
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Exhaust motoko's single reconnect attempt to start its cool-down.
    FakeWebSocket.instances[0].close()
    vi.advanceTimersByTime(1)
    FakeWebSocket.instances.at(-1)!.close()

    // The eviction sweep runs at 10s. Motoko is the oldest-silent syncer,
    // but it is cooling; the fence must divert eviction to idle batou.
    vi.advanceTimersByTime(10_000)

    const active = sync.getActiveActors()
    expect(active).toContain('did:plc:motoko')
    expect(active).toContain('did:plc:togusa')
    expect(active).not.toContain('did:plc:batou')

    sync.stop()
  })
})
