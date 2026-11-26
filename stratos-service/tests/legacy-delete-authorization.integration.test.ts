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
import { createRecord } from '../src/api/records/create.js'
import { deleteRecord } from '../src/api/records/delete.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const PILOT = 'did:plc:shinji-ikari'
const COLLECTION = 'zone.stratos.feed.post'
const RKEY = 'eva01'
const URI = `at://${PILOT}/${COLLECTION}/${RKEY}`

interface BoundaryRowEditor {
  replaceRecordBoundaries(
    uri: string,
    boundaries: readonly string[],
  ): Promise<void>
}

// The SQLite wrapper keeps its core transactor private; Postgres is the transactor itself.
function boundaryRowEditor(record: unknown): BoundaryRowEditor {
  const wrapped = record as { transactor?: BoundaryRowEditor }
  return wrapped.transactor ?? (record as BoundaryRowEditor)
}

function defineLegacyDeleteAuthorization(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let emit: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    await createRecord(
      harness.ctx,
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey: RKEY,
        record: {
          $type: COLLECTION,
          text: 'Sortie',
          createdAt: '1997-07-19T00:00:00.000Z',
          boundary: { values: [{ value: HARNESS_ENGINEERING }] },
        },
      },
      PILOT,
    )
    emit = vi.spyOn(harness.ctx.sequenceEvents, 'emit')
  })

  afterEach(() => {
    emit.mockRestore()
  })

  const deleteTheRecord = () =>
    deleteRecord(
      harness.ctx,
      { repo: PILOT, collection: COLLECTION, rkey: RKEY },
      PILOT,
    )

  async function storeRecordIn(boundaries: string[]) {
    await harness.ctx.actorStore.transact(PILOT, (store) =>
      boundaryRowEditor(store.record).replaceRecordBoundaries(URI, boundaries),
    )
  }

  async function snapshot() {
    return {
      rows: await harness.recordRows(URI),
      root: await harness.repoRoot(PILOT),
      ops: await harness.sequencedOps(PILOT),
    }
  }

  /** Runs a change after the up-front checks, just before the repo lock. */
  function mutateBeforeNextAcquire(mutate: () => Promise<void>) {
    const locks = harness.ctx.repoWriteLocks
    const realAcquire = locks.acquire.bind(locks)
    let armed = true
    return vi.spyOn(locks, 'acquire').mockImplementation(async (did) => {
      if (armed) {
        armed = false
        await mutate()
      }
      return realAcquire(did)
    })
  }

  const removeFromBoundary = (boundary: string) => async () => {
    expect((await harness.removeBoundary(PILOT, boundary)).status).toBe(200)
  }

  const refusals: Array<[string, string, () => () => Promise<void>]> = [
    ['an operator hold', 'NotEnrolled', () => () => harness.holdMember(PILOT)],
    [
      'a removal from the boundary the record is in',
      'ForbiddenBoundary',
      () => removeFromBoundary(HARNESS_ENGINEERING),
    ],
  ]

  it.each(refusals)(
    'refuses a delete after %s lands before the lock and changes nothing',
    async (_name, error, change) => {
      const before = await snapshot()
      const acquire = mutateBeforeNextAcquire(change())

      try {
        await expect(deleteTheRecord()).rejects.toMatchObject({
          customErrorName: error,
        })
      } finally {
        acquire.mockRestore()
      }

      expect(await snapshot()).toEqual(before)
      expect(before.rows.record).not.toBeNull()
      expect(emit).not.toHaveBeenCalled()
    },
  )

  it('refuses a delete of a record stored in a boundary the member no longer holds, though it holds another', async () => {
    await storeRecordIn([HARNESS_DESIGN, HARNESS_ENGINEERING])
    await removeFromBoundary(HARNESS_DESIGN)()
    const before = await snapshot()

    await expect(deleteTheRecord()).rejects.toMatchObject({
      customErrorName: 'ForbiddenBoundary',
    })

    expect(await snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('deletes a record in a boundary the member holds and sequences its removal', async () => {
    await deleteTheRecord()

    expect((await harness.recordRows(URI)).record).toBeNull()
    const removals = (await harness.sequencedOps(PILOT))
      .filter((op) => op.action === 'delete')
      .map(({ scope }) => scope)
    expect(removals).toEqual([[], [HARNESS_ENGINEERING]])
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('refuses a held member a delete of a record stored in no boundary', async () => {
    await storeRecordIn([])
    await harness.holdMember(PILOT)
    const before = await snapshot()

    await expect(deleteTheRecord()).rejects.toMatchObject({
      customErrorName: 'NotEnrolled',
    })

    expect(await snapshot()).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('deletes a record stored in no boundary for a member in good standing', async () => {
    await storeRecordIn([])

    await deleteTheRecord()

    expect((await harness.recordRows(URI)).record).toBeNull()
  })
}

describe('legacy delete authorization on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineLegacyDeleteAuthorization(() => harness)
})

describe('legacy delete authorization on postgres', () => {
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

  defineLegacyDeleteAuthorization(() => harness)
})
