import { encode as cborEncode } from '@atcute/cbor'
import { StratosError } from '@northskysocial/stratos-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSqliteDb,
  type FeedgenStore,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import {
  ActorSyncer,
  type IndexCommitArgs,
  SubscriptionIndexer,
} from '../src/subscription/index.js'

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

  open(): void {
    this.readyState = WS_OPEN
    for (const cb of this.openListeners) cb()
  }

  send(frame: Uint8Array): void {
    this.onmessage?.({ data: frame })
  }
}

// ---- Helpers -----------------------------------------------------------

function encodeCommitFrame(body: {
  seq: number
  time: string
  ops: Array<{
    action: 'create' | 'update' | 'delete'
    path: string
    cid?: string
    record?: Record<string, unknown>
  }>
}): Uint8Array {
  const header = cborEncode({ op: 1, t: '#commit' })
  const bodyBuf = cborEncode(body)
  const out = new Uint8Array(header.length + bodyBuf.length)
  out.set(header, 0)
  out.set(bodyBuf, header.length)
  return out
}

function postRecord(text: string): Record<string, unknown> {
  return {
    $type: 'zone.stratos.feed.post',
    text,
    createdAt: '2024-01-01T00:00:00.000Z',
    boundary: { values: [{ value: 'example.com/eng' }] },
  }
}

/**
 * Wrap the real indexer so a chosen sequence throws before it reaches the
 * store. Delegating on success keeps the cursor behaviour real, which is what
 * the durability assertions turn on.
 */
function wrapIndexer(
  real: SubscriptionIndexer,
  shouldFail: (seq: number) => boolean,
): { calls: number[]; indexer: SubscriptionIndexer } {
  const calls: number[] = []
  const wrapped = {
    applyCommit: async (args: IndexCommitArgs): Promise<void> => {
      calls.push(args.seq)
      if (shouldFail(args.seq)) throw new Error('sqlite is busy')
      await real.applyCommit(args)
    },
  }
  return { calls, indexer: wrapped as unknown as SubscriptionIndexer }
}

function commitFrame(seq: number): Uint8Array {
  return encodeCommitFrame({
    seq,
    time: '2024-02-01T00:00:00.000Z',
    ops: [
      {
        action: 'create',
        path: `zone.stratos.feed.post/r${seq}`,
        cid: `bafy${seq}`,
        record: postRecord(`post ${seq}`),
      },
    ],
  })
}

/** A `#commit` frame whose body is whatever the caller supplies, valid or not. */
function rawCommitFrame(body: unknown): Uint8Array {
  const header = cborEncode({ op: 1, t: '#commit' })
  const bodyBuf = cborEncode(body as never)
  const out = new Uint8Array(header.length + bodyBuf.length)
  out.set(header, 0)
  out.set(bodyBuf, header.length)
  return out
}

function codesOf(errors: Error[]): string[] {
  return errors.map((err) => (err as StratosError).code)
}

const tmpDirs: string[] = []
let store: FeedgenStore
let indexer: SubscriptionIndexer

beforeEach(async () => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-syncer-'))
  tmpDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  store = new SqliteFeedgenStore(db)
  indexer = new SubscriptionIndexer(store)
})

afterEach(async () => {
  vi.useRealTimers()
  await store.close()
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

const DID = 'did:plc:alice'

describe('ActorSyncer', () => {
  it('streams 10 commits → 10 rows + cursor advanced', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok-1',
      },
      {
        store,
        indexer,
        wsCtor: FakeWebSocket as never,
        rng: () => 1,
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    for (let i = 1; i <= 10; i++) {
      ws.send(
        encodeCommitFrame({
          seq: i,
          time: `2024-02-0${i % 10}T00:00:00.000Z`,
          ops: [
            {
              action: 'create',
              path: `zone.stratos.feed.post/r${i}`,
              cid: `bafy${i}`,
              record: postRecord(`post ${i}`),
            },
          ],
        }),
      )
    }
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(10)
    })
    const list = await store.listPostsByBoundary({
      boundary: 'example.com/eng',
      limit: 100,
    })
    expect(list.posts).toHaveLength(10)
    syncer.stop()
  })

  it('reconnects with saved cursor as a ?cursor= query param', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok-1',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      {
        store,
        indexer,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const first = FakeWebSocket.instances[0]
    first.open()
    expect(first.url).not.toContain('cursor=')
    first.send(
      encodeCommitFrame({
        seq: 42,
        time: '2024-02-01T00:00:00.000Z',
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/r1',
            cid: 'bafy1',
            record: postRecord('hi'),
          },
        ],
      }),
    )
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(42)
    })
    first.close()
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const second = FakeWebSocket.instances[1]
    expect(second.url).toContain('cursor=42')
    expect(second.url).toContain(`did=${encodeURIComponent(DID)}`)
    expect(second.url).not.toContain('syncToken=')
    expect(second.authHeader).toBe('Bearer tok-1')
    syncer.stop()
  })

  it('delete op removes the post', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok-1',
      },
      { store, indexer, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.send(
      encodeCommitFrame({
        seq: 1,
        time: '2024-02-01T00:00:00.000Z',
        ops: [
          {
            action: 'create',
            path: 'zone.stratos.feed.post/r1',
            cid: 'bafy1',
            record: postRecord('hi'),
          },
        ],
      }),
    )
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(1)
    })
    ws.send(
      encodeCommitFrame({
        seq: 2,
        time: '2024-02-02T00:00:00.000Z',
        ops: [{ action: 'delete', path: 'zone.stratos.feed.post/r1' }],
      }),
    )
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(2)
      expect(
        await store.getPost(`at://${DID}/zone.stratos.feed.post/r1`),
      ).toBeNull()
    })
    syncer.stop()
  })

  it('mints a fresh token on every (re)connect', async () => {
    let n = 0
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => `tok-${++n}`,
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      { store, indexer, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(FakeWebSocket.instances[0].authHeader).toBe('Bearer tok-1')
    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.instances[1].authHeader).toBe('Bearer tok-2')
    syncer.stop()
  })

  it('does not reconnect after stop()', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      { store, indexer, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    syncer.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not reset backoff when a connection drops before the stability window', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
        stabilityResetMs: 10_000,
      },
      { store, indexer, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Open, then drop before the 10s window → attempt 1, reconnect at 1_000ms.
    FakeWebSocket.instances[0].open()
    await vi.advanceTimersByTimeAsync(5_000)
    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    // Open then drop again → attempt must escalate to 2 (2_000ms), proving the
    // `open` event alone did not reset the backoff counter.
    FakeWebSocket.instances[1].open()
    await vi.advanceTimersByTimeAsync(5_000)
    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))

    syncer.stop()
  })

  it('resets backoff after a connection stays open past the stability window', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
        stabilityResetMs: 5_000,
      },
      { store, indexer, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Two quick drops escalate the delay to 2_000ms (attempt 2).
    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))

    // Stay open past the 5s window → backoff resets, next drop is 1_000ms again.
    FakeWebSocket.instances[2].open()
    await vi.advanceTimersByTimeAsync(5_000)
    FakeWebSocket.instances[2].close()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))

    syncer.stop()
  })

  it('does not apply frames buffered behind a failed commit', async () => {
    const errors: Error[] = []
    const { calls, indexer: failing } = wrapIndexer(indexer, (seq) => seq === 1)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      {
        store,
        indexer: failing,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    // One synchronous burst: seq 2 and 3 are sitting in the queue when seq 1
    // fails. Applying either of them would carry the cursor past seq 1.
    ws.send(commitFrame(1))
    ws.send(commitFrame(2))
    ws.send(commitFrame(3))

    await vi.waitFor(() =>
      expect(codesOf(errors)).toContain('ACTOR_SYNC_APPLY_FAILED'),
    )
    expect(calls).toEqual([1])
    expect(ws.readyState).toBe(WS_CLOSED)
    expect(await store.getCursor(DID)).toBeNull()
    // The queue is emptied, not merely abandoned: nothing else is drained, so
    // the failure reports exactly once and produces no downstream noise.
    expect(codesOf(errors)).toEqual(['ACTOR_SYNC_APPLY_FAILED'])
    syncer.stop()
  })

  it('does not accumulate failures at different sequences toward the alarm', async () => {
    const errors: Error[] = []
    const { calls, indexer: failing } = wrapIndexer(indexer, () => true)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
        stabilityResetMs: 60_000,
      },
      {
        store,
        indexer: failing,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()

    // Three failures, each at a DIFFERENT sequence. The counter tracks a stuck
    // sequence, not a flaky store, so this must not trip the alarm.
    for (let cycle = 0; cycle < 3; cycle++) {
      await vi.waitFor(() =>
        expect(FakeWebSocket.instances).toHaveLength(cycle + 1),
      )
      FakeWebSocket.instances[cycle].open()
      FakeWebSocket.instances[cycle].send(commitFrame(cycle + 1))
      await vi.waitFor(() => expect(calls).toHaveLength(cycle + 1))
      await vi.advanceTimersByTimeAsync(1_500)
    }

    expect(calls).toEqual([1, 2, 3])
    expect(codesOf(errors)).not.toContain('ACTOR_SYNC_STALLED')
    syncer.stop()
  })

  it('reports undecodable frames without dropping the connection', async () => {
    const errors: Error[] = []
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
      },
      {
        store,
        indexer,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    // Garbage header.
    ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
    // Valid header, garbage body.
    const header = cborEncode({ op: 1, t: '#commit' })
    const badBody = new Uint8Array(header.length + 3)
    badBody.set(header, 0)
    badBody.set([0xff, 0xff, 0xff], header.length)
    ws.send(badBody)

    await vi.waitFor(() =>
      expect(
        codesOf(errors).filter((c) => c === 'ACTOR_SYNC_FRAME_UNDECODABLE'),
      ).toHaveLength(2),
    )
    // Both report the actor and keep the decoder's own error as the cause.
    for (const err of errors) {
      expect(err.message).toContain(DID)
      expect(err.cause).toBeDefined()
    }
    // Undecodable frames are not retryable, so the stream stays up and keeps
    // consuming rather than wedging the actor.
    expect(ws.readyState).toBe(WS_OPEN)
    ws.send(commitFrame(4))
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(4)
    })
    syncer.stop()
  })

  it('treats a decodable but malformed commit body as an undecodable frame', async () => {
    const errors: Error[] = []
    const applied: number[] = []
    const recording = {
      applyCommit: async (args: IndexCommitArgs): Promise<void> => {
        applied.push(args.seq)
        await indexer.applyCommit(args)
      },
    } as unknown as SubscriptionIndexer
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      {
        store,
        indexer: recording,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    const time = '2024-02-01T00:00:00.000Z'
    // `ops` is not iterable. Handing this to applyCommit would throw and be
    // misread as a transient store fault, stalling the actor forever on a
    // frame that can never succeed.
    ws.send(rawCommitFrame({ seq: 1, time, ops: 'nope' }))
    // `seq` is not a number, and applyCommit writes it straight to the cursor.
    ws.send(rawCommitFrame({ seq: 'nope', time, ops: [] }))
    // `time` is absent, and applyCommit stores it as `indexedAt`.
    ws.send(rawCommitFrame({ seq: 2, ops: [] }))
    // Not a map. `null` and a bare scalar are distinct hazards: indexing into
    // `null` throws, and that throw would escape drain() as an unhandled
    // rejection instead of being reported.
    ws.send(rawCommitFrame(['not', 'a', 'commit']))
    ws.send(rawCommitFrame(null))
    ws.send(rawCommitFrame(42))

    await vi.waitFor(() =>
      expect(
        codesOf(errors).filter((c) => c === 'ACTOR_SYNC_FRAME_UNDECODABLE'),
      ).toHaveLength(6),
    )
    for (const err of errors) {
      expect(err.message).toContain(DID)
      expect(err.message).toContain('malformed commit body')
    }
    // None of them reached the apply path, so no garbage cursor landed.
    expect(applied).toEqual([])
    expect(await store.getCursor(DID)).toBeNull()
    // Deterministic frame faults follow the decode policy: report and continue.
    expect(ws.readyState).toBe(WS_OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)

    ws.send(commitFrame(7))
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(7)
    })
    syncer.stop()
  })

  it('ignores a close event that arrives after the socket was detached', async () => {
    const { indexer: failing } = wrapIndexer(indexer, (seq) => seq === 1)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      { store, indexer: failing, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const first = FakeWebSocket.instances[0]
    first.open()
    // The apply failure abandons this socket and schedules the reconnect.
    first.send(commitFrame(1))
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const second = FakeWebSocket.instances[1]
    second.open()

    // `close()` only starts the handshake, so the abandoned socket's close can
    // land here — after its replacement is already live.
    first.onclose?.()

    // Ownership stayed with the live socket, so no second reconnect fires...
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    // ...and its frames are still consumed, rather than being discarded by the
    // superseded-socket guard against a `ws` the stale close had nulled.
    second.send(commitFrame(2))
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(2)
    })
    syncer.stop()
  })

  it('reports the store error as the cause of the apply failure', async () => {
    const errors: Error[] = []
    const diskFull = new Error('SQLITE_FULL: database or disk is full')
    const failing = {
      applyCommit: async (): Promise<void> => {
        throw diskFull
      },
    } as unknown as SubscriptionIndexer
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      {
        store,
        indexer: failing,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].send(commitFrame(11))

    await vi.waitFor(() =>
      expect(codesOf(errors)).toContain('ACTOR_SYNC_APPLY_FAILED'),
    )
    const reported = errors.find(
      (err) => (err as StratosError).code === 'ACTOR_SYNC_APPLY_FAILED',
    )
    // An operator triaging a stalled actor needs both the sequence and the
    // original store error, so neither may be dropped.
    expect(reported?.message).toContain('seq 11')
    expect(reported?.message).toContain(DID)
    expect(reported?.cause).toBe(diskFull)
    syncer.stop()
  })

  it('keeps consuming undecodable frames with no onError sink wired', async () => {
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      // onError deliberately omitted — reporting is optional, durability is not.
      { store, indexer, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    // Garbage header, a valid header with a garbage body, then a body that
    // decodes but is malformed: all three reject paths must tolerate the
    // absent sink.
    ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
    ws.send(rawCommitFrame({ seq: 1, time: '2024-02-01T00:00:00.000Z' }))
    const header = cborEncode({ op: 1, t: '#commit' })
    const badBody = new Uint8Array(header.length + 3)
    badBody.set(header, 0)
    badBody.set([0xff, 0xff, 0xff], header.length)
    ws.send(badBody)
    await vi.advanceTimersByTimeAsync(50)

    expect(ws.readyState).toBe(WS_OPEN)
    ws.send(commitFrame(3))
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(3)
    })
    syncer.stop()
  })

  it('stalls on an apply failure with no onError sink wired', async () => {
    const { calls, indexer: failing } = wrapIndexer(indexer, (seq) => seq === 1)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      // onError omitted: durability must not depend on a reporting sink being
      // wired, so the reconnect and the cursor hold regardless.
      { store, indexer: failing, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.send(commitFrame(1))
    ws.send(commitFrame(2))

    await vi.waitFor(() => expect(calls).toEqual([1]))
    expect(ws.readyState).toBe(WS_CLOSED)
    expect(await store.getCursor(DID)).toBeNull()

    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.instances[1].url).not.toContain('cursor=')
    syncer.stop()
  })

  it('overflows at exactly maxQueueSize and drops the connection', async () => {
    const errors: Error[] = []
    const gate: { release: (() => void) | null } = { release: null }
    const blocking = {
      applyCommit: async (): Promise<void> => {
        await new Promise<void>((resolve) => (gate.release = resolve))
      },
    } as unknown as SubscriptionIndexer
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        maxQueueSize: 3,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      {
        store,
        indexer: blocking,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()

    // First frame occupies the drain; the next three fill the queue exactly.
    ws.send(commitFrame(1))
    await vi.waitFor(() => expect(gate.release).not.toBeNull())
    for (let i = 2; i <= 4; i++) ws.send(commitFrame(i))
    expect(codesOf(errors)).not.toContain('ACTOR_SYNC_OVERFLOW')

    ws.send(commitFrame(5))
    expect(codesOf(errors)).toContain('ACTOR_SYNC_OVERFLOW')
    expect(ws.readyState).toBe(WS_CLOSED)

    gate.release?.()
    syncer.stop()
  })

  it('re-applies the failed sequence after reconnect and lands the cursor on it', async () => {
    const errors: Error[] = []
    let failuresLeft = 1
    const { calls, indexer: flaky } = wrapIndexer(indexer, () => {
      if (failuresLeft > 0) {
        failuresLeft--
        return true
      }
      return false
    })
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      {
        store,
        indexer: flaky,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].send(commitFrame(7))

    await vi.waitFor(() =>
      expect(codesOf(errors)).toContain('ACTOR_SYNC_APPLY_FAILED'),
    )
    expect(await store.getCursor(DID)).toBeNull()

    await vi.advanceTimersByTimeAsync(1_500)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const second = FakeWebSocket.instances[1]
    // The cursor never advanced, so the reconnect asks for the same ground.
    expect(second.url).not.toContain('cursor=')
    second.open()
    second.send(commitFrame(7))

    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(7)
    })
    expect(calls).toEqual([7, 7])
    syncer.stop()
  })

  it('alarms once and never advances past a deterministically failing commit', async () => {
    const errors: Error[] = []
    const { calls, indexer: failing } = wrapIndexer(indexer, (seq) => seq === 5)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
        stabilityResetMs: 60_000,
      },
      {
        store,
        indexer: failing,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()

    const stallsAfter: number[] = []
    for (let cycle = 0; cycle < 4; cycle++) {
      await vi.waitFor(() =>
        expect(FakeWebSocket.instances).toHaveLength(cycle + 1),
      )
      const ws = FakeWebSocket.instances[cycle]
      ws.open()
      ws.send(commitFrame(5))
      await vi.waitFor(() => expect(calls).toHaveLength(cycle + 1))
      stallsAfter.push(
        codesOf(errors).filter((code) => code === 'ACTOR_SYNC_STALLED').length,
      )
      await vi.advanceTimersByTimeAsync(1_500)
    }

    expect(calls).toEqual([5, 5, 5, 5])
    // Silent for the first two failures, one alarm on the third, silent after.
    expect(stallsAfter).toEqual([0, 0, 1, 1])
    // Never stepped over: no later sequence was ever attempted.
    expect(await store.getCursor(DID)).toBeNull()
    syncer.stop()
  })

  it('escalates reconnect backoff while a commit keeps failing', async () => {
    const { indexer: failing } = wrapIndexer(indexer, (seq) => seq === 5)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
        stabilityResetMs: 60_000,
      },
      { store, indexer: failing, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()

    // Each failure kills the connection well inside the stability window, so
    // the attempt counter never resets and the delay must double.
    let idx = 0
    for (const expectedDelay of [1_000, 2_000, 4_000]) {
      await vi.waitFor(() =>
        expect(FakeWebSocket.instances).toHaveLength(idx + 1),
      )
      const ws = FakeWebSocket.instances[idx]
      ws.open()
      ws.send(commitFrame(5))
      // The apply failure closes the socket in microtasks, which advancing
      // flushes; the reconnect timer itself is still short of firing.
      await vi.advanceTimersByTimeAsync(expectedDelay - 1)
      expect(ws.readyState).toBe(WS_CLOSED)
      expect(FakeWebSocket.instances).toHaveLength(idx + 1)
      await vi.advanceTimersByTimeAsync(1)
      idx++
    }
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))

    syncer.stop()
  })

  it('resets the failure counter after a successful apply', async () => {
    const errors: Error[] = []
    let failuresAtNine = 0
    const { calls, indexer: flaky } = wrapIndexer(indexer, (seq) => {
      if (seq === 9) {
        failuresAtNine++
        return failuresAtNine <= 2
      }
      return seq === 10
    })
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
        stabilityResetMs: 60_000,
      },
      {
        store,
        indexer: flaky,
        wsCtor: FakeWebSocket as never,
        rng: () => 0,
        onError: (err) => errors.push(err),
      },
    )
    syncer.start()

    // Two failures at seq 9 — one short of the alarm.
    for (let cycle = 0; cycle < 2; cycle++) {
      await vi.waitFor(() =>
        expect(FakeWebSocket.instances).toHaveLength(cycle + 1),
      )
      FakeWebSocket.instances[cycle].open()
      FakeWebSocket.instances[cycle].send(commitFrame(9))
      await vi.waitFor(() => expect(calls).toHaveLength(cycle + 1))
      await vi.advanceTimersByTimeAsync(1_500)
    }

    // Third attempt succeeds, which must clear the counter.
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    FakeWebSocket.instances[2].open()
    FakeWebSocket.instances[2].send(commitFrame(9))
    await vi.waitFor(async () => {
      expect(await store.getCursor(DID)).toBe(9)
    })

    // A fresh failure at seq 10 is failure #1, not #3 — no alarm.
    FakeWebSocket.instances[2].send(commitFrame(10))
    await vi.waitFor(() => expect(calls).toEqual([9, 9, 9, 10]))
    expect(codesOf(errors)).not.toContain('ACTOR_SYNC_STALLED')
    syncer.stop()
  })

  it('ignores frames from a socket that was already dropped', async () => {
    const { calls, indexer: failing } = wrapIndexer(indexer, (seq) => seq === 1)
    const syncer = new ActorSyncer(
      {
        did: DID,
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
      },
      { store, indexer: failing, wsCtor: FakeWebSocket as never, rng: () => 0 },
    )
    syncer.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.send(commitFrame(1))
    await vi.waitFor(() => expect(calls).toEqual([1]))

    // A late delivery from the abandoned socket must not refill the queue that
    // failConnection just cleared.
    ws.send(commitFrame(2))
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toEqual([1])
    expect(await store.getCursor(DID)).toBeNull()
    syncer.stop()
  })
})
