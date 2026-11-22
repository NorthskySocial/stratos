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
import * as fc from 'fast-check'
import {
  pgStratosRecordBoundary,
  stratosRecordBoundary,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context.js'
import { createRecord } from '../src/api/records/index.js'
import { authorizeRecordBoundary } from '../src/api/records/validation.js'
import type { ActorStore } from '../src/actor-store-types.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import {
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const LEADERSHIP = `${SERVICE_DID}/leadership`
const PILOT = `${SERVICE_DID}/pilot`
const COLLECTION = 'zone.stratos.feed.post'

function postWithBoundaries(text: string, boundaries: string[]) {
  return {
    $type: COLLECTION,
    text,
    createdAt: new Date().toISOString(),
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    },
  }
}

describe('Record indexing from an explicit boundary on the runtime Postgres store', () => {
  let actorStore: ActorStore
  const testDid = 'did:plc:kaji-ryoji'

  beforeAll(async () => {
    const connectionString = await startPostgresContainer()
    actorStore = new PostgresActorStore({
      connectionString,
      blobstore: createMockBlobStoreCreator(),
      cborToRecord,
    })
  }, 120_000)

  afterAll(async () => {
    await actorStore.destroy(testDid).catch(() => undefined)
    await stopPostgresContainer()
  }, 60_000)

  beforeEach(async () => {
    await actorStore.create(testDid)
  })

  afterEach(async () => {
    await actorStore.destroy(testDid)
  })

  async function indexInBoundary(
    rkey: string,
    record: Record<string, unknown>,
    boundary: string,
    action: 'create' | 'update',
  ) {
    await actorStore.transact(testDid, async (store) => {
      await store.record.indexRecordInBoundary(
        `at://${testDid}/${COLLECTION}/${rkey}`,
        await createCid(JSON.stringify(record)),
        record,
        boundary,
        action,
        `rev-${action}`,
      )
    })
  }

  function boundariesOf(rkey: string) {
    return actorStore.read(testDid, async (store) => {
      const rows = await (
        store.record as unknown as {
          db: {
            select: () => {
              from: (
                table: unknown,
              ) => Promise<Array<{ recordUri: string; boundary: string }>>
            }
          }
        }
      ).db
        .select()
        .from(pgStratosRecordBoundary)
      return rows
        .filter((row) => row.recordUri.endsWith(`/${rkey}`))
        .map((row) => row.boundary)
    })
  }

  it('writes exactly one row for the given boundary when the body has none', async () => {
    await indexInBoundary(
      'ritsuko',
      { $type: COLLECTION, text: 'MAGI' },
      ENGINEERING,
      'create',
    )

    expect(await boundariesOf('ritsuko')).toEqual([ENGINEERING])
  })

  it('writes only the given boundary when the body names a different one', async () => {
    await indexInBoundary(
      'maya',
      postWithBoundaries('Casper', [LEADERSHIP, PILOT]),
      ENGINEERING,
      'create',
    )

    expect(await boundariesOf('maya')).toEqual([ENGINEERING])
  })

  it('replaces the boundary rows on update', async () => {
    await indexInBoundary(
      'makoto',
      postWithBoundaries('Balthasar', [LEADERSHIP]),
      ENGINEERING,
      'create',
    )
    await indexInBoundary(
      'makoto',
      postWithBoundaries('Balthasar v2', [LEADERSHIP]),
      PILOT,
      'update',
    )

    expect(await boundariesOf('makoto')).toEqual([PILOT])
  })
})

describe('Create indexes the authorized boundary', () => {
  let harness: WriteHarness
  let ctx: AppContext
  let actorStore: AppContext['actorStore']

  const testDid = 'did:plc:shinji-ikari'

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    ctx = harness.ctx
    actorStore = ctx.actorStore
    await harness.enrollMember(testDid, [ENGINEERING])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await harness.close()
  })

  it('stores the body boundary as the single row and indexes through indexRecordInBoundary', async () => {
    const indexInBoundary = vi.fn()
    const indexFromBody = vi.fn()
    const originalTransact = actorStore.transact.bind(actorStore)
    vi.spyOn(actorStore, 'transact').mockImplementation(((
      did: string,
      fn: (store: any) => Promise<unknown>,
    ) =>
      originalTransact(did, (store) => {
        const record = store.record
        const inBoundary = record.indexRecordInBoundary.bind(record)
        const fromBody = record.indexRecord.bind(record)
        record.indexRecordInBoundary = (
          ...args: Parameters<typeof inBoundary>
        ) => {
          indexInBoundary(...args)
          return inBoundary(...args)
        }
        record.indexRecord = (...args: Parameters<typeof fromBody>) => {
          indexFromBody(...args)
          return fromBody(...args)
        }
        return fn(store)
      })) as typeof actorStore.transact)

    await createRecord(
      ctx,
      {
        repo: testDid,
        collection: COLLECTION,
        rkey: 'unit01',
        record: postWithBoundaries('Get in the robot', [ENGINEERING]),
      },
      testDid,
    )

    const rows = await actorStore.read(testDid, (store) =>
      (
        store.record as unknown as {
          reader: {
            db: {
              select: () => {
                from: (
                  table: unknown,
                ) => Promise<Array<{ recordUri: string; boundary: string }>>
              }
            }
          }
        }
      ).reader.db
        .select()
        .from(stratosRecordBoundary),
    )
    expect(rows).toEqual([
      {
        recordUri: `at://${testDid}/${COLLECTION}/unit01`,
        boundary: ENGINEERING,
      },
    ])
    expect(indexInBoundary).toHaveBeenCalledTimes(1)
    expect(indexInBoundary.mock.calls[0][3]).toBe(ENGINEERING)
    expect(indexFromBody).not.toHaveBeenCalled()
  })
})

describe('authorizeRecordBoundary properties', () => {
  const callerDid = 'did:plc:misato-katsuragi'

  const skeyArb = fc
    .stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
    .filter((name) => name.length > 0)
  const boundaryArb = skeyArb.map((name) => `${SERVICE_DID}/${name}`)

  // Each run enrolls a caller, so a hundred runs outlast the default limit
  // on a busy machine.
  const PROPERTY_TIMEOUT_MS = 60_000

  let harness: WriteHarness
  let callers = 0

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterAll(async () => {
    await harness.close()
  })

  async function callerHolding(held: string[]) {
    const caller = `${callerDid}-${callers++}`
    await harness.enrollBoundaryHolder(caller, held)
    return caller
  }

  it(
    'returns the exact requested boundary when the caller holds it',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          boundaryArb,
          fc.array(boundaryArb, { maxLength: 4 }),
          async (requested, otherHeld) => {
            const held = [...otherHeld, requested]
            const authorized = await authorizeRecordBoundary(
              harness.ctx,
              await callerHolding(held),
              COLLECTION,
              postWithBoundaries('Eva', [requested]),
            )
            expect(authorized).toBe(requested)
          },
        ),
      )
    },
    PROPERTY_TIMEOUT_MS,
  )

  it(
    'rejects a requested boundary the caller does not hold with ForbiddenBoundary',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          boundaryArb,
          fc.array(boundaryArb, { maxLength: 4 }),
          async (requested, held) => {
            fc.pre(!held.includes(requested))
            await expect(
              authorizeRecordBoundary(
                harness.ctx,
                await callerHolding(held),
                COLLECTION,
                postWithBoundaries('Eva', [requested]),
              ),
            ).rejects.toMatchObject({ customErrorName: 'ForbiddenBoundary' })
          },
        ),
      )
    },
    PROPERTY_TIMEOUT_MS,
  )

  it(
    'rejects zero or several requested boundaries with InvalidDomainCount',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(boundaryArb, { maxLength: 4 }).filter((b) => b.length !== 1),
          async (requested) => {
            await expect(
              authorizeRecordBoundary(
                harness.ctx,
                await callerHolding(requested),
                COLLECTION,
                postWithBoundaries('Eva', requested),
              ),
            ).rejects.toMatchObject({ customErrorName: 'InvalidDomainCount' })
          },
        ),
      )
    },
    PROPERTY_TIMEOUT_MS,
  )
})
