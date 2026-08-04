import { encode as cborEncode } from '@atcute/cbor'
import { StratosError } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceStream } from '../src/subscription/service-stream.js'

// ---- Fake WebSocket ----------------------------------------------------

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSED = 3

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState: number = WS_CONNECTING
  binaryType = ''
  url: string
  authHeader: string | undefined
  onmessage: ((e: { data: Uint8Array | ArrayBuffer }) => void) | null = null
  onerror: ((e: Event & { error?: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  private openListeners: Array<() => void> = []

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url
    this.authHeader = options?.headers?.authorization
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: 'open', cb: () => void): void {
    if (type === 'open') this.openListeners.push(cb)
  }

  close(): void {
    if (this.readyState === WS_CLOSED) return
    this.readyState = WS_CLOSED
    this.onclose?.()
  }

  // helpers for tests
  open(): void {
    this.readyState = WS_OPEN
    for (const cb of this.openListeners) cb()
  }

  send(frame: Uint8Array): void {
    this.onmessage?.({ data: frame })
  }

  fail(err: Error): void {
    this.onerror?.(Object.assign(new Event('error'), { error: err }))
  }

  // Simulate the underlying socket emitting 'close' more than once (some ws
  // stacks fire error+close). Bypasses the idempotency guard in close().
  fireClose(): void {
    this.readyState = WS_CLOSED
    this.onclose?.()
  }
}

// ---- Helpers -----------------------------------------------------------

function encodeEnrollmentFrame(body: {
  did: string
  action: 'enroll' | 'unenroll' | 'boundaries'
  boundaries?: string[]
  time?: string
}): Uint8Array {
  const header = cborEncode({ op: 1, t: '#enrollment' })
  const bodyBuf = cborEncode({
    $type: 'zone.stratos.sync.subscribeRecords#enrollment',
    did: body.did,
    action: body.action,
    boundaries: body.boundaries ?? [],
    time: body.time ?? new Date().toISOString(),
  })
  const out = new Uint8Array(header.length + bodyBuf.length)
  out.set(header, 0)
  out.set(bodyBuf, header.length)
  return out
}

function codesOf(errors: Error[]): string[] {
  return errors.map((err) => (err as StratosError).code)
}

/**
 * A promise the test can hold open, used to keep one handler in flight while
 * further frames are delivered.
 */
function makeGate(): {
  release: (() => void) | null
  wait: () => Promise<void>
} {
  const gate: { release: (() => void) | null; wait: () => Promise<void> } = {
    release: null,
    wait: () => new Promise<void>((resolve) => (gate.release = resolve)),
  }
  return gate
}

function makeMintToken(): { fn: () => Promise<string>; calls: number } {
  const state = { fn: async () => '', calls: 0 }
  state.fn = async () => {
    state.calls++
    return `token-${state.calls}`
  }
  return state
}

// ---- Tests -------------------------------------------------------------

describe('ServiceStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches enroll events to the callback', async () => {
    const mint = makeMintToken()
    const enrolls: Array<{ did: string; boundaries: string[] }> = []
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
      },
      {
        onEnroll: (did, boundaries) => {
          enrolls.push({ did, boundaries })
        },
        onUnenroll: () => {},
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    expect(stream.isConnected()).toBe(true)

    ws.send(
      encodeEnrollmentFrame({
        did: 'did:plc:nadia',
        action: 'enroll',
        boundaries: ['fukuoka', 'tokyo'],
      }),
    )
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:bulma', action: 'enroll' }))
    ws.send(
      encodeEnrollmentFrame({
        did: 'did:plc:goku',
        action: 'enroll',
        boundaries: ['kame-house'],
      }),
    )

    await vi.waitFor(() => expect(enrolls).toHaveLength(3))
    expect(enrolls).toEqual([
      { did: 'did:plc:nadia', boundaries: ['fukuoka', 'tokyo'] },
      { did: 'did:plc:bulma', boundaries: [] },
      { did: 'did:plc:goku', boundaries: ['kame-house'] },
    ])
    expect(mint.calls).toBe(1)
    stream.stop()
  })

  it('dispatches unenroll events to the callback', async () => {
    const mint = makeMintToken()
    const enrolls: string[] = []
    const unenrolls: string[] = []
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
      },
      {
        onEnroll: (did) => {
          enrolls.push(did)
        },
        onUnenroll: (did) => {
          unenrolls.push(did)
        },
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.send(
      encodeEnrollmentFrame({
        did: 'did:plc:utena',
        action: 'enroll',
        boundaries: ['ohtori'],
      }),
    )
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:utena', action: 'unenroll' }))

    await vi.waitFor(() => {
      expect(enrolls).toEqual(['did:plc:utena'])
      expect(unenrolls).toEqual(['did:plc:utena'])
    })
    stream.stop()
  })

  it('dispatches boundaries-change events to onBoundariesChanged', async () => {
    const mint = makeMintToken()
    const changes: Array<{ did: string; boundaries: string[] }> = []
    const enrolls: string[] = []
    const unenrolls: string[] = []
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
      },
      {
        onEnroll: (did) => {
          enrolls.push(did)
        },
        onUnenroll: (did) => {
          unenrolls.push(did)
        },
        onBoundariesChanged: (did, boundaries) => {
          changes.push({ did, boundaries })
        },
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.send(
      encodeEnrollmentFrame({
        did: 'did:plc:asuka',
        action: 'boundaries',
        boundaries: ['nerv/eva-02'],
      }),
    )

    await vi.waitFor(() =>
      expect(changes).toEqual([
        { did: 'did:plc:asuka', boundaries: ['nerv/eva-02'] },
      ]),
    )
    // The change frame must not be misrouted as enroll/unenroll.
    expect(enrolls).toEqual([])
    expect(unenrolls).toEqual([])
    stream.stop()
  })

  it('ignores boundaries-change frames when no onBoundariesChanged handler is wired', async () => {
    const mint = makeMintToken()
    const errors: Error[] = []
    const enrolls: string[] = []
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
      },
      {
        onEnroll: (did) => {
          enrolls.push(did)
        },
        onUnenroll: () => {},
        // onBoundariesChanged intentionally omitted.
      },
      (err) => {
        errors.push(err)
      },
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.send(
      encodeEnrollmentFrame({
        did: 'did:plc:asuka',
        action: 'boundaries',
        boundaries: ['nerv/eva-02'],
      }),
    )
    // A following enroll frame must still be delivered — the optional-callback
    // no-op must not break the consumer loop.
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:rei', action: 'enroll' }))

    await vi.waitFor(() => expect(enrolls).toEqual(['did:plc:rei']))
    expect(errors).toEqual([])
    stream.stop()
  })

  it('reconnects with exponential backoff capped at maxDelay, with jitter', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 5000,
        maxDelayMs: 60000,
        jitterRatio: 0.2,
      },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 1 }, // jitter = +20%
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Drop attempt 1 → next delay = 5000 + 20% = 6000
    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(5999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    // Drop attempt 2 → next delay = 10000 + 20% = 12000
    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(11999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))

    // Drop attempt 5 should already be capped to 60000 + 20% = 72000
    FakeWebSocket.instances[2].close()
    await vi.advanceTimersByTimeAsync(24000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))
    FakeWebSocket.instances[3].close()
    await vi.advanceTimersByTimeAsync(48000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(5))
    FakeWebSocket.instances[4].close()
    // attempt 6 would be 5000*2^5 = 160000, capped to 60000, +20% = 72000
    await vi.advanceTimersByTimeAsync(71999)
    expect(FakeWebSocket.instances).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(6))

    expect(mint.calls).toBe(6)
    stream.stop()
  })

  it('mints a fresh sync token on every reconnect', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 1000,
        maxDelayMs: 1000,
        jitterRatio: 0,
      },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(FakeWebSocket.instances[0].authHeader).toBe('Bearer token-1')

    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.instances[1].authHeader).toBe('Bearer token-2')

    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    expect(FakeWebSocket.instances[2].authHeader).toBe('Bearer token-3')
    expect(mint.calls).toBe(3)
    stream.stop()
  })

  it('logs malformed frames via onError and keeps consuming', async () => {
    const mint = makeMintToken()
    const errors: Error[] = []
    const enrolls: string[] = []
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
      },
      {
        onEnroll: (did) => {
          enrolls.push(did)
        },
        onUnenroll: () => {},
      },
      (err) => {
        errors.push(err)
      },
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
    ws.send(
      encodeEnrollmentFrame({
        did: 'did:plc:rei',
        action: 'enroll',
        boundaries: ['nerv'],
      }),
    )

    await vi.waitFor(() => {
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(enrolls).toEqual(['did:plc:rei'])
    })
    expect(stream.isConnected()).toBe(true)
    stream.stop()
  })

  it('isConnected reflects WebSocket state', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      { stratosServiceUrl: 'http://stratos.test', mintToken: mint.fn },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    expect(stream.isConnected()).toBe(false)
    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(stream.isConnected()).toBe(false)
    FakeWebSocket.instances[0].open()
    expect(stream.isConnected()).toBe(true)
    FakeWebSocket.instances[0].close()
    expect(stream.isConnected()).toBe(false)
    stream.stop()
  })

  it('stop() cancels pending reconnects and closes the active socket', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 1000,
        maxDelayMs: 1000,
        jitterRatio: 0,
      },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0].close()
    // reconnect scheduled
    stream.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not reset backoff when a connection drops before the stability window', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        jitterRatio: 0,
        stabilityResetMs: 10000,
      },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Open, then drop before the 10s window → attempt 1, reconnect at 1000ms.
    FakeWebSocket.instances[0].open()
    await vi.advanceTimersByTimeAsync(5000)
    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    // Open then drop again → attempt must escalate to 2 (2000ms), proving the
    // `open` event alone did not reset the backoff counter.
    FakeWebSocket.instances[1].open()
    await vi.advanceTimersByTimeAsync(5000)
    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(1999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))

    stream.stop()
  })

  it('resets backoff after a connection stays open past the stability window', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        jitterRatio: 0,
        stabilityResetMs: 5000,
      },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Two quick drops escalate the delay to 2000ms (attempt 2).
    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))

    // Stay open past the 5s window → backoff resets, next drop is 1000ms again.
    FakeWebSocket.instances[2].open()
    await vi.advanceTimersByTimeAsync(5000)
    FakeWebSocket.instances[2].close()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))

    stream.stop()
  })

  it('schedules only one reconnect when close fires more than once', async () => {
    const mint = makeMintToken()
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        jitterRatio: 0,
      },
      { onEnroll: () => {}, onUnenroll: () => {} },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // A socket that emits close twice must not double-schedule reconnects.
    FakeWebSocket.instances[0].fireClose()
    FakeWebSocket.instances[0].fireClose()

    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    // A second (overlapping) reconnect at attempt 2 would fire at 2000ms and
    // create a third socket; the guard must prevent that.
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    stream.stop()
  })

  it('processes frames in delivery order when a handler is slow', async () => {
    const mint = makeMintToken()
    const order: string[] = []
    const gate = makeGate()
    const stream = new ServiceStream(
      { stratosServiceUrl: 'http://stratos.test', mintToken: mint.fn },
      {
        onEnroll: async (did) => {
          if (did === 'did:plc:kenshin') await gate.wait()
          order.push(did)
        },
        onUnenroll: () => {},
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.send(encodeEnrollmentFrame({ did: 'did:plc:kenshin', action: 'enroll' }))
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:kaoru', action: 'enroll' }))

    await vi.waitFor(() => expect(gate.release).not.toBeNull())
    // The second frame must still be queued, not racing the first.
    expect(order).toEqual([])

    gate.release?.()
    await vi.waitFor(() =>
      expect(order).toEqual(['did:plc:kenshin', 'did:plc:kaoru']),
    )
    stream.stop()
  })

  it('keeps an unenroll behind the enroll it follows', async () => {
    const mint = makeMintToken()
    const order: string[] = []
    const gate = makeGate()
    const stream = new ServiceStream(
      { stratosServiceUrl: 'http://stratos.test', mintToken: mint.fn },
      {
        onEnroll: async (did) => {
          await gate.wait()
          order.push(`enroll:${did}`)
        },
        onUnenroll: (did) => {
          order.push(`unenroll:${did}`)
        },
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.send(encodeEnrollmentFrame({ did: 'did:plc:lina', action: 'enroll' }))
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:lina', action: 'unenroll' }))

    await vi.waitFor(() => expect(gate.release).not.toBeNull())
    gate.release?.()
    // Unserialized dispatch would let the synchronous unenroll land first and
    // leave the actor enrolled.
    await vi.waitFor(() =>
      expect(order).toEqual(['enroll:did:plc:lina', 'unenroll:did:plc:lina']),
    )
    stream.stop()
  })

  it('drops the connection when the enrollment queue overflows', async () => {
    const mint = makeMintToken()
    const errors: Error[] = []
    const gate = makeGate()
    const stream = new ServiceStream(
      { stratosServiceUrl: 'http://stratos.test', mintToken: mint.fn },
      {
        onEnroll: async () => {
          await gate.wait()
        },
        onUnenroll: () => {},
      },
      (err) => {
        errors.push(err)
      },
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    const frame = encodeEnrollmentFrame({
      did: 'did:plc:vash',
      action: 'enroll',
    })
    // First frame occupies the drain; the next 1000 fill the queue exactly.
    ws.send(frame)
    await vi.waitFor(() => expect(gate.release).not.toBeNull())
    for (let i = 0; i < 1_000; i++) ws.send(frame)
    expect(codesOf(errors)).not.toContain('SERVICE_STREAM_OVERFLOW')

    // One past the cap.
    ws.send(frame)
    expect(codesOf(errors)).toContain('SERVICE_STREAM_OVERFLOW')
    expect(ws.readyState).toBe(WS_CLOSED)

    gate.release?.()
    // The queue is emptied on overflow, so nothing is drained afterwards and
    // the overflow is the only thing reported.
    await vi.advanceTimersByTimeAsync(100)
    expect(codesOf(errors)).toEqual(['SERVICE_STREAM_OVERFLOW'])

    // Reconnect replays every enrollment from scratch, so the drop is lossless.
    await vi.advanceTimersByTimeAsync(6_000)
    await vi.waitFor(() =>
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1),
    )
    stream.stop()
  })

  it('ignores frames from a socket that was already dropped', async () => {
    const mint = makeMintToken()
    const enrolls: string[] = []
    const stream = new ServiceStream(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: mint.fn,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      {
        onEnroll: (did) => {
          enrolls.push(did)
        },
        onUnenroll: () => {},
      },
      undefined,
      { wsCtor: FakeWebSocket as never, rng: () => 0.5 },
    )

    stream.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:milly', action: 'enroll' }))
    await vi.waitFor(() => expect(enrolls).toEqual(['did:plc:milly']))

    ws.close()
    // A late delivery from the abandoned socket belongs to a connection whose
    // state has already been torn down.
    ws.send(encodeEnrollmentFrame({ did: 'did:plc:meryl', action: 'enroll' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(enrolls).toEqual(['did:plc:milly'])
    stream.stop()
  })
})
