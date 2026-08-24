import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSqliteDb,
  type FeedgenStore,
  migrateSqliteDb,
  SqliteFeedgenStore,
} from '../src/db/index.js'
import {
  ActorPool,
  type ActorSyncer,
  type ActorSyncerConfig,
  SubscriptionIndexer,
} from '../src/subscription/index.js'

// A trivial fake syncer that just records its lifecycle.
class FakeSyncer {
  static instances: FakeSyncer[] = []
  did: string
  started = false
  stopped = false
  lastMessageAt = 0
  // ts: match the real ActorSyncer's runtime shape we use from ActorPool
  constructor(public config: ActorSyncerConfig) {
    this.did = config.did
    FakeSyncer.instances.push(this)
  }
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  async drainAndStop(): Promise<void> {
    this.stop()
  }
  setConnectGate(_gate: (() => Promise<void>) | null): void {
    // ignored in tests
  }
  getLastMessageAt(): number {
    return this.lastMessageAt
  }
}

const tmpDirs: string[] = []
let store: FeedgenStore
let indexer: SubscriptionIndexer

beforeEach(async () => {
  FakeSyncer.instances = []
  const dir = await mkdtemp(join(tmpdir(), 'feedgen-pool-'))
  tmpDirs.push(dir)
  const db = createSqliteDb(join(dir, 'feedgen.sqlite'))
  await migrateSqliteDb(db)
  store = new SqliteFeedgenStore(db)
  indexer = new SubscriptionIndexer(store)
})

afterEach(async () => {
  await store.close()
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

function makePool(maxConnections = 256): ActorPool {
  return new ActorPool(
    {
      stratosServiceUrl: 'http://stratos.test',
      mintToken: async () => 'tok',
      maxConnections,
      connectDelayMs: 0,
      idleEvictionMs: 0,
    },
    {
      store,
      indexer,
      syncerFactory: (config) =>
        new FakeSyncer(config) as unknown as ActorSyncer,
    },
  )
}

function findSyncer(did: string): FakeSyncer {
  const s = FakeSyncer.instances.find((s) => s.did === did)
  if (!s) throw new Error(`no syncer for ${did}`)
  return s
}

describe('ActorPool', () => {
  it('addActor is idempotent and tracks active actors', () => {
    const pool = makePool()
    pool.start()
    expect(pool.addActor('did:plc:a')).toBe(true)
    expect(pool.addActor('did:plc:a')).toBe(true)
    expect(pool.addActor('did:plc:b')).toBe(true)
    expect(pool.getActiveActors().sort()).toEqual(['did:plc:a', 'did:plc:b'])
    expect(FakeSyncer.instances).toHaveLength(2)
    expect(FakeSyncer.instances.every((s) => s.started)).toBe(true)
  })

  it('respects the concurrency cap and queues extras', () => {
    const pool = makePool(2)
    pool.start()
    for (let i = 0; i < 5; i++) pool.addActor(`did:plc:${i}`)
    expect(pool.getActiveActors()).toHaveLength(2)
    expect(pool.getWaitingActors()).toEqual([
      'did:plc:2',
      'did:plc:3',
      'did:plc:4',
    ])
  })

  it('promotes a waiting actor when an active one is removed', () => {
    const pool = makePool(2)
    pool.start()
    pool.addActor('did:plc:a')
    pool.addActor('did:plc:b')
    pool.addActor('did:plc:c')
    expect(pool.getActiveActors().sort()).toEqual(['did:plc:a', 'did:plc:b'])
    pool.removeActor('did:plc:a')
    expect(pool.getActiveActors().sort()).toEqual(['did:plc:b', 'did:plc:c'])
    expect(pool.getWaitingActors()).toEqual([])
  })

  it('removeActor on a waiting actor removes it from the queue', () => {
    const pool = makePool(1)
    pool.start()
    pool.addActor('did:plc:a')
    pool.addActor('did:plc:b')
    pool.addActor('did:plc:c')
    expect(pool.getWaitingActors()).toEqual(['did:plc:b', 'did:plc:c'])
    pool.removeActor('did:plc:b')
    expect(pool.getWaitingActors()).toEqual(['did:plc:c'])
    pool.removeActor('did:plc:a')
    expect(pool.getActiveActors()).toEqual(['did:plc:c'])
  })

  it('stop() tears down all active syncers and clears state', async () => {
    const pool = makePool(2)
    pool.start()
    pool.addActor('did:plc:a')
    pool.addActor('did:plc:b')
    await pool.stop()
    expect(pool.getActiveActors()).toEqual([])
    expect(FakeSyncer.instances.every((s) => s.stopped)).toBe(true)
  })

  it('stop() drains the rest and reports the failure when one syncer rejects', async () => {
    const errors: Error[] = []
    const pool = new ActorPool(
      {
        stratosServiceUrl: 'http://stratos.test',
        mintToken: async () => 'tok',
        connectDelayMs: 0,
        idleEvictionMs: 0,
      },
      {
        store,
        indexer,
        onError: (err) => errors.push(err),
        syncerFactory: (config) => {
          const syncer = new FakeSyncer(config)
          if (config.did === 'did:plc:jimhawking') {
            syncer.drainAndStop = async (): Promise<void> => {
              throw new Error('drain wedged')
            }
          }
          return syncer as unknown as ActorSyncer
        },
      },
    )
    pool.start()
    pool.addActor('did:plc:jimhawking')
    pool.addActor('did:plc:genestarwind')

    await pool.stop()

    expect(errors.map((e) => e.message)).toEqual(['drain wedged'])
    expect(findSyncer('did:plc:genestarwind').stopped).toBe(true)
  })

  it('seedFromStore adds only actors with matching boundaries', async () => {
    const now = new Date().toISOString()
    await store.upsertEnrolledActor({
      did: 'did:plc:match',
      boundaries: ['example.com/eng'],
      enrolledAt: now,
      lastSeenAt: now,
    })
    await store.upsertEnrolledActor({
      did: 'did:plc:nomatch',
      boundaries: ['other.example/foo'],
      enrolledAt: now,
      lastSeenAt: now,
    })
    const pool = makePool()
    pool.start()
    const added = await pool.seedFromStore(new Set(['example.com/eng']))
    expect(added).toBe(1)
    expect(pool.getActiveActors()).toEqual(['did:plc:match'])
  })

  it('refuses to add actors before start()', () => {
    const pool = makePool()
    expect(pool.addActor('did:plc:a')).toBe(false)
    expect(pool.getActiveActors()).toEqual([])
  })

  describe('idle eviction', () => {
    function makeEvictingPool(maxConnections: number, nowRef: { t: number }) {
      return new ActorPool(
        {
          stratosServiceUrl: 'http://stratos.test',
          mintToken: async () => 'tok',
          maxConnections,
          connectDelayMs: 0,
          idleEvictionMs: 1000,
          evictionCheckIntervalMs: 60_000,
        },
        {
          store,
          indexer,
          syncerFactory: (config) =>
            new FakeSyncer(config) as unknown as ActorSyncer,
          now: () => nowRef.t,
        },
      )
    }

    it('evicts idle actors when waiters are present and promotes from queue', () => {
      const now = { t: 10_000 }
      const pool = makeEvictingPool(2, now)
      pool.start()
      pool.addActor('did:plc:a')
      pool.addActor('did:plc:b')
      pool.addActor('did:plc:c') // waits
      findSyncer('did:plc:a').lastMessageAt = 1_000 // idle (9s old)
      findSyncer('did:plc:b').lastMessageAt = 9_500 // fresh
      const evicted = pool.evictIdle()
      expect(evicted).toEqual(['did:plc:a'])
      expect(pool.getActiveActors().sort()).toEqual(['did:plc:b', 'did:plc:c'])
      expect(pool.getWaitingActors()).toEqual(['did:plc:a'])
      expect(findSyncer('did:plc:a').stopped).toBe(true)
    })

    it('does not evict when there are no waiting actors', () => {
      const now = { t: 10_000 }
      const pool = makeEvictingPool(5, now)
      pool.start()
      pool.addActor('did:plc:a')
      pool.addActor('did:plc:b')
      findSyncer('did:plc:a').lastMessageAt = 0 // very idle
      findSyncer('did:plc:b').lastMessageAt = 0 // very idle
      expect(pool.evictIdle()).toEqual([])
      expect(pool.getActiveActors().sort()).toEqual(['did:plc:a', 'did:plc:b'])
    })

    it('does not evict syncers that are still fresh', () => {
      const now = { t: 10_000 }
      const pool = makeEvictingPool(1, now)
      pool.start()
      pool.addActor('did:plc:a')
      pool.addActor('did:plc:b') // waits
      findSyncer('did:plc:a').lastMessageAt = 9_500 // fresh (<1s old)
      expect(pool.evictIdle()).toEqual([])
      expect(pool.getActiveActors()).toEqual(['did:plc:a'])
    })

    it('evicts oldest first and caps by waiter count', () => {
      const now = { t: 10_000 }
      const pool = makeEvictingPool(3, now)
      pool.start()
      pool.addActor('did:plc:a')
      pool.addActor('did:plc:b')
      pool.addActor('did:plc:c')
      pool.addActor('did:plc:d') // 1 waiter
      findSyncer('did:plc:a').lastMessageAt = 2_000
      findSyncer('did:plc:b').lastMessageAt = 1_000 // oldest
      findSyncer('did:plc:c').lastMessageAt = 3_000
      const evicted = pool.evictIdle()
      expect(evicted).toEqual(['did:plc:b'])
      expect(pool.getActiveActors().sort()).toEqual([
        'did:plc:a',
        'did:plc:c',
        'did:plc:d',
      ])
    })

    it('evicted actor stays enrolled and rotates back when promoted', () => {
      const now = { t: 10_000 }
      const pool = makeEvictingPool(1, now)
      pool.start()
      pool.addActor('did:plc:a')
      pool.addActor('did:plc:b') // waits
      findSyncer('did:plc:a').lastMessageAt = 0 // idle
      pool.evictIdle()
      expect(pool.getActiveActors()).toEqual(['did:plc:b'])
      expect(pool.getWaitingActors()).toEqual(['did:plc:a'])
      // removeActor on the now-active b promotes a back in
      pool.removeActor('did:plc:b')
      expect(pool.getActiveActors()).toEqual(['did:plc:a'])
      expect(pool.getWaitingActors()).toEqual([])
    })

    it('disabled when idleEvictionMs is 0', () => {
      const pool = makePool(1) // idleEvictionMs: 0
      pool.start()
      pool.addActor('did:plc:a')
      pool.addActor('did:plc:b')
      findSyncer('did:plc:a').lastMessageAt = 0
      expect(pool.evictIdle()).toEqual([])
    })
  })
})
