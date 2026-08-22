import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StratosError } from '@northskysocial/stratos-core'
import type { CursorManager } from '../src/index.js'
import {
  ActorSyncer,
  type ActorSyncerOptions,
} from '../src/sync/actor-syncer.js'

const RECONNECT_COOLDOWN_MS = 300_000
const RECONNECT_BASE_DELAY_MS = 1_000
const MAX_ATTEMPTS = 3

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onerror: ((e: Event & { error?: unknown }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

function createSyncer(overrides: Partial<ActorSyncerOptions> = {}) {
  const errors: Error[] = []
  const cursorManager = {
    getStratosCursor: vi.fn(() => undefined),
    updateStratosCursor: vi.fn(),
    removeStratosCursor: vi.fn(),
  } as unknown as CursorManager

  const syncer = new ActorSyncer('did:plc:usagi', {} as never, cursorManager, {
    stratosServiceUrl: 'http://localhost:2583',
    syncToken: 'moon-prism-power',
    maxActorQueueSize: 10,
    drainDelayMs: 1,
    reconnectBaseDelayMs: RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs: 60_000,
    reconnectJitterMs: 0,
    reconnectMaxAttempts: MAX_ATTEMPTS,
    reconnectCooldownMs: RECONNECT_COOLDOWN_MS,
    onError: (err) => errors.push(err),
    canStartSync: () => true,
    onSyncStarted: () => {},
    onSyncFinished: () => {},
    ...overrides,
  })

  return { syncer, errors }
}

/** Fail every connection until the attempt cap is exhausted. */
function exhaustAttempts(): void {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    FakeWebSocket.instances.at(-1)!.close()
    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1))
  }
  FakeWebSocket.instances.at(-1)!.close()
}

describe('ActorSyncer reconnect cool-down', () => {
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

  it('reports a coded cool-down error and reconnects instead of giving up', () => {
    const { syncer, errors } = createSyncer()
    syncer.start()

    exhaustAttempts()

    const cooldownErrors = errors.filter(
      (err) =>
        err instanceof StratosError && err.code === 'ACTOR_SYNC_COOLDOWN',
    )
    expect(cooldownErrors).toHaveLength(1)
    expect(cooldownErrors[0].message).toContain('did:plc:usagi')

    const connectionsBeforeCooldown = FakeWebSocket.instances.length
    expect(connectionsBeforeCooldown).toBe(MAX_ATTEMPTS + 1)

    vi.advanceTimersByTime(RECONNECT_COOLDOWN_MS - 1)
    expect(FakeWebSocket.instances).toHaveLength(connectionsBeforeCooldown)

    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(connectionsBeforeCooldown + 1)

    syncer.stop()
  })

  it('cancels the cool-down timer on stop', () => {
    const { syncer } = createSyncer()
    syncer.start()

    exhaustAttempts()
    const connectionsBeforeStop = FakeWebSocket.instances.length

    syncer.stop()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(RECONNECT_COOLDOWN_MS * 3)
    expect(FakeWebSocket.instances).toHaveLength(connectionsBeforeStop)
  })

  it('reports isCoolingDown only while the cool-down timer is pending', () => {
    const { syncer } = createSyncer()
    syncer.start()
    expect(syncer.isCoolingDown()).toBe(false)

    exhaustAttempts()
    expect(syncer.isCoolingDown()).toBe(true)

    vi.advanceTimersByTime(RECONNECT_COOLDOWN_MS)
    expect(syncer.isCoolingDown()).toBe(false)

    syncer.stop()
  })

  it('clears isCoolingDown on stop', () => {
    const { syncer } = createSyncer()
    syncer.start()

    exhaustAttempts()
    expect(syncer.isCoolingDown()).toBe(true)

    syncer.stop()
    expect(syncer.isCoolingDown()).toBe(false)
  })

  it('honors a configured cool-down duration', () => {
    const { syncer } = createSyncer({ reconnectCooldownMs: 5_000 })
    syncer.start()

    exhaustAttempts()
    const connectionsBeforeCooldown = FakeWebSocket.instances.length

    vi.advanceTimersByTime(4_999)
    expect(FakeWebSocket.instances).toHaveLength(connectionsBeforeCooldown)

    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(connectionsBeforeCooldown + 1)

    syncer.stop()
  })

  it('restarts the backoff series at the base delay after a cool-down', () => {
    const { syncer } = createSyncer()
    syncer.start()

    exhaustAttempts()
    vi.advanceTimersByTime(RECONNECT_COOLDOWN_MS)

    const connectionsAfterCooldown = FakeWebSocket.instances.length
    FakeWebSocket.instances.at(-1)!.close()

    vi.advanceTimersByTime(RECONNECT_BASE_DELAY_MS - 1)
    expect(FakeWebSocket.instances).toHaveLength(connectionsAfterCooldown)

    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(connectionsAfterCooldown + 1)

    syncer.stop()
  })
})
