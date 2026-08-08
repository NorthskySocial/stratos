import { StratosError } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StratosServiceSubscription } from '../src/index.js'

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
})
