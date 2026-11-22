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
import * as CAR from '@atcute/car'
import * as AtcuteCid from '@atcute/cid'
import { exportRepoCarStream } from '@northskysocial/stratos-core'
import type { AppContext } from '../src/context.js'
import { applyBoundaryWrites } from '../src/api/records/boundary-writes.js'
import { applyWritesBatch } from '../src/api/records/batch.js'
import { createRecord } from '../src/api/records/create.js'
import { updateRecord } from '../src/api/records/update.js'
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

const PILOT = 'did:plc:misato-katsuragi'
const COLLECTION = 'zone.stratos.feed.post'
const EXISTING_RKEY = 'unit-00'
const WRITTEN_RKEY = 'unit-01'
const INTERLOPER_RKEY = 'unit-02'

function post(text: string) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1997-07-19T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: HARNESS_ENGINEERING }],
    },
  }
}

function postWithoutBoundary(text: string) {
  const { boundary: _boundary, ...rest } = post(text)
  return rest
}

interface Writer {
  name: string
  /** Writes one record and returns its CID. */
  write(ctx: AppContext): Promise<string>
}

function cidOf(result: { cid?: string }): string {
  if (!result.cid) throw new Error('the write returned no record CID')
  return result.cid
}

const WRITERS: Writer[] = [
  {
    name: 'a boundary create',
    write: async (ctx) => {
      const { results } = await applyBoundaryWrites(
        ctx,
        PILOT,
        HARNESS_ENGINEERING,
        [
          {
            kind: 'create',
            collection: COLLECTION,
            rkey: WRITTEN_RKEY,
            record: postWithoutBoundary('Angel attack'),
          },
        ],
      )
      return cidOf(results[0])
    },
  },
  {
    name: 'a boundary put of a stored record',
    write: async (ctx) => {
      const { results } = await applyBoundaryWrites(
        ctx,
        PILOT,
        HARNESS_ENGINEERING,
        [
          {
            kind: 'put',
            collection: COLLECTION,
            rkey: EXISTING_RKEY,
            record: postWithoutBoundary('Angel attack, revised'),
          },
        ],
      )
      return cidOf(results[0])
    },
  },
  {
    name: 'a legacy batch create',
    write: async (ctx) => {
      const { results } = await applyWritesBatch(ctx, PILOT, [
        {
          action: 'create',
          collection: COLLECTION,
          rkey: WRITTEN_RKEY,
          record: post('Angel attack'),
        },
      ])
      return cidOf(results[0])
    },
  },
  {
    name: 'a legacy create',
    write: async (ctx) =>
      cidOf(
        await createRecord(
          ctx,
          {
            repo: PILOT,
            collection: COLLECTION,
            rkey: WRITTEN_RKEY,
            record: post('Angel attack'),
          },
          PILOT,
        ),
      ),
  },
  {
    name: 'a legacy update',
    write: async (ctx) =>
      cidOf(
        await updateRecord(
          ctx,
          {
            repo: PILOT,
            collection: COLLECTION,
            rkey: EXISTING_RKEY,
            record: post('Angel attack, revised'),
          },
          PILOT,
        ),
      ),
  },
]

function defineRevisionScenarios(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let acquire: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])
    await createRecord(
      harness.ctx,
      {
        repo: PILOT,
        collection: COLLECTION,
        rkey: EXISTING_RKEY,
        record: post('Third Impact drill'),
      },
      PILOT,
    )
  })

  afterEach(() => {
    acquire?.mockRestore()
    acquire = undefined
  })

  /**
   * Commits another write of the same member once the next write has done all
   * its work outside the lock and asks for the lock.
   * @returns where the revision of that other commit is recorded once it lands
   */
  function commitAnotherWriteBeforeNextAcquire(): { rev?: string } {
    const interloper: { rev?: string } = {}
    const locks = harness.ctx.repoWriteLocks
    const realAcquire = locks.acquire.bind(locks)
    let armed = true
    acquire = vi.spyOn(locks, 'acquire').mockImplementation(async (did) => {
      if (armed) {
        armed = false
        const { commit } = await createRecord(
          harness.ctx,
          {
            repo: PILOT,
            collection: COLLECTION,
            rkey: INTERLOPER_RKEY,
            record: post('Interloper sortie'),
          },
          PILOT,
        )
        interloper.rev = commit?.rev
      }
      return realAcquire(did)
    })
    return interloper
  }

  async function exportedCidsSince(since: string): Promise<string[]> {
    const car = await harness.ctx.actorStore.read(PILOT, async (store) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of exportRepoCarStream(store.repo, since)) {
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    })
    return [...CAR.fromUint8Array(car)].map((entry) =>
      AtcuteCid.toString(entry.cid),
    )
  }

  it.each(WRITERS)(
    '$name exports its record block after a write that committed while it waited',
    async (writer) => {
      const interloper = commitAnotherWriteBeforeNextAcquire()

      const writtenCid = await writer.write(harness.ctx)

      if (!interloper.rev) throw new Error('the other write did not commit')
      expect(await exportedCidsSince(interloper.rev)).toContain(writtenCid)
    },
  )
}

describe('record block revision on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineRevisionScenarios(() => harness)
})

describe('record block revision on postgres', () => {
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

  defineRevisionScenarios(() => harness)
})
