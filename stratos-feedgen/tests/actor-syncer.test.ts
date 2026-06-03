import { encode as cborEncode } from '@atcute/cbor'
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
import { ActorSyncer, SubscriptionIndexer } from '../src/subscription/index.js'

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
})
