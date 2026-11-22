import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ActorTransactor } from '../src/actor-store-types.js'
import {
  applyBoundaryWrites,
  type BoundaryWrite,
} from '../src/api/records/boundary-writes.js'
import {
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:rei-ayanami'
const COLLECTION = 'zone.stratos.feed.post'
const RKEYS = ['eva00', 'eva01', 'eva02']
const FAILURE_MESSAGE = 'Pen Pen chewed through the umbilical cable'

const uriOf = (rkey: string) => `at://${PILOT}/${COLLECTION}/${rkey}`

function post(text: string) {
  return { $type: COLLECTION, text, createdAt: '1995-10-04T00:00:00.000Z' }
}

const BATCH: BoundaryWrite[] = [
  {
    kind: 'put',
    collection: COLLECTION,
    rkey: 'eva00',
    record: post('Prototype, revised'),
  },
  {
    kind: 'create',
    collection: COLLECTION,
    rkey: 'eva01',
    record: post('Test type'),
  },
  {
    kind: 'create',
    collection: COLLECTION,
    rkey: 'eva02',
    record: post('Production model'),
  },
]

/** A step of the commit transaction that runs once per write. */
interface FailurePoint {
  name: string
  /** Makes the second call of the step throw; earlier calls go through. */
  breakSecondCall(store: ActorTransactor): void
}

function throwOnSecondCall<T extends object, K extends keyof T>(
  target: T,
  method: K,
): void {
  const real = (target[method] as (...args: unknown[]) => unknown).bind(target)
  let calls = 0
  vi.spyOn(target, method as never).mockImplementation(((
    ...args: unknown[]
  ) => {
    calls += 1
    if (calls === 2) throw new Error(FAILURE_MESSAGE)
    return real(...args)
  }) as never)
}

const FAILURE_POINTS: FailurePoint[] = [
  {
    name: 'the second sequence event',
    breakSecondCall: (store) =>
      throwOnSecondCall(store.sequence, 'appendEvent'),
  },
  {
    name: 'the second record index',
    breakSecondCall: (store) =>
      throwOnSecondCall(store.record, 'indexRecordInBoundary'),
  },
]

function defineRollbackScenarios(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let emit: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])
    await applyBoundaryWrites(harness.ctx, PILOT, HARNESS_ENGINEERING, [
      {
        kind: 'create',
        collection: COLLECTION,
        rkey: 'eva00',
        record: post('Prototype'),
      },
    ])
    emit = vi.spyOn(harness.ctx.sequenceEvents, 'emit')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function breakNextTransaction(point: FailurePoint): void {
    const actorStore = harness.ctx.actorStore
    const realTransact = actorStore.transact.bind(actorStore)
    vi.spyOn(actorStore, 'transact').mockImplementation((did, fn) =>
      realTransact(did, (store) => {
        point.breakSecondCall(store)
        return fn(store)
      }),
    )
  }

  async function storedBlockCids(): Promise<string[]> {
    return harness.ctx.actorStore.read(PILOT, async (store) => {
      const cids: string[] = []
      for await (const block of store.repo.iterateCarBlocks()) {
        cids.push(block.cid.toString())
      }
      return cids.sort()
    })
  }

  async function snapshot() {
    return {
      root: await harness.repoRoot(PILOT),
      rows: await Promise.all(
        RKEYS.map((rkey) => harness.recordRows(uriOf(rkey))),
      ),
      blocks: await storedBlockCids(),
      ops: await harness.sequencedOps(PILOT),
    }
  }

  it.each(FAILURE_POINTS)(
    'stores and sequences nothing when $name fails inside the commit',
    async (point) => {
      const before = await snapshot()
      breakNextTransaction(point)

      await expect(
        applyBoundaryWrites(harness.ctx, PILOT, HARNESS_ENGINEERING, BATCH),
      ).rejects.toThrow(FAILURE_MESSAGE)

      expect(emit).not.toHaveBeenCalled()
      expect(await snapshot()).toEqual(before)
    },
  )
}

describe('boundary write rollback on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineRollbackScenarios(() => harness)
})

describe('boundary write rollback on postgres', () => {
  let connectionString: string
  let harness: WriteHarness

  beforeAll(async () => {
    connectionString = await startPostgresContainer()
  }, 120_000)

  afterAll(async () => {
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    harness = await startPostgresWriteHarness(connectionString)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineRollbackScenarios(() => harness)
})
