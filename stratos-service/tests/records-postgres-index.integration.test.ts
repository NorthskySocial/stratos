import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  pgStratosBacklink,
  pgStratosRecord,
  pgStratosRecordBoundary,
} from '@northskysocial/stratos-core'

import type { ActorStore } from '../src/actor-store-types.js'
import { PostgresActorStore } from '../src/infra/storage/postgres/index.js'
import {
  cborToRecord,
  createCid,
  createMockBlobStoreCreator,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const LEADERSHIP = `${SERVICE_DID}/leadership`
const COLLECTION = 'zone.stratos.graph.follow'
const REI = 'did:plc:rei-ayanami'
const KAWORU = 'did:plc:kaworu-nagisa'

function follow(subject: string, boundary: string) {
  return {
    $type: COLLECTION,
    subject,
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: boundary }],
    },
  }
}

type Action = 'create' | 'update'

describe('Record indexing backlinks and boundaries on the runtime Postgres store', () => {
  let actorStore: ActorStore
  const testDid = 'did:plc:misato-katsuragi'

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
  })

  beforeEach(async () => {
    await actorStore.create(testDid)
  })

  afterEach(async () => {
    await actorStore.destroy(testDid)
  })

  const uriOf = (rkey: string) => `at://${testDid}/${COLLECTION}/${rkey}`

  async function indexFromBody(
    rkey: string,
    record: Record<string, unknown> | null,
    action: Action,
    rev: string,
  ) {
    await actorStore.transact(testDid, async (store) => {
      await store.record.indexRecord(
        uriOf(rkey),
        await createCid(JSON.stringify(record)),
        record,
        action,
        rev,
      )
    })
  }

  async function indexInBoundary(
    rkey: string,
    record: Record<string, unknown>,
    action: Action,
    rev: string,
  ) {
    await actorStore.transact(testDid, async (store) => {
      await store.record.indexRecordInBoundary(
        uriOf(rkey),
        await createCid(JSON.stringify(record)),
        record,
        ENGINEERING,
        action,
        rev,
      )
    })
  }

  type RowSource = {
    db: { select: () => { from: (table: unknown) => Promise<unknown[]> } }
  }

  function rowsOf<Row>(table: unknown, rkey: string, uriKey: keyof Row) {
    return actorStore.read(testDid, async (store) => {
      const rows = (await (store.record as unknown as RowSource).db
        .select()
        .from(table)) as Row[]
      return rows.filter((row) => String(row[uriKey]).endsWith(`/${rkey}`))
    })
  }

  const backlinksOf = (rkey: string) =>
    rowsOf<{ uri: string; path: string; linkTo: string }>(
      pgStratosBacklink,
      rkey,
      'uri',
    )

  const boundariesOf = async (rkey: string) =>
    (
      await rowsOf<{ recordUri: string; boundary: string }>(
        pgStratosRecordBoundary,
        rkey,
        'recordUri',
      )
    ).map((row) => row.boundary)

  it('indexRecord keeps only the backlink of the updated subject', async () => {
    await indexFromBody('rei', follow(REI, ENGINEERING), 'create', 'rev1')
    await indexFromBody('rei', follow(KAWORU, ENGINEERING), 'update', 'rev2')

    expect(await backlinksOf('rei')).toEqual([
      { uri: uriOf('rei'), path: 'subject', linkTo: KAWORU },
    ])
  })

  it('indexRecordInBoundary keeps only the backlink of the updated subject', async () => {
    await indexInBoundary('rei', follow(REI, ENGINEERING), 'create', 'rev1')
    await indexInBoundary('rei', follow(KAWORU, ENGINEERING), 'update', 'rev2')

    expect(await backlinksOf('rei')).toEqual([
      { uri: uriOf('rei'), path: 'subject', linkTo: KAWORU },
    ])
  })

  it('indexRecord with a null record updates the row and leaves backlinks and boundary rows untouched', async () => {
    await indexFromBody('asuka', follow(REI, ENGINEERING), 'create', 'rev1')
    const backlinksBefore = await backlinksOf('asuka')
    expect(backlinksBefore).toHaveLength(1)
    expect(await boundariesOf('asuka')).toEqual([ENGINEERING])

    await expect(
      indexFromBody('asuka', null, 'update', 'rev2'),
    ).resolves.toBeUndefined()

    expect(await backlinksOf('asuka')).toEqual(backlinksBefore)
    expect(await boundariesOf('asuka')).toEqual([ENGINEERING])
    const recordRows = await rowsOf<{ uri: string; repoRev: string }>(
      pgStratosRecord,
      'asuka',
      'uri',
    )
    expect(recordRows).toHaveLength(1)
    expect(recordRows[0].repoRev).toBe('rev2')
  })

  it('indexRecord writes the boundary and backlink from the body on create and replaces both on update', async () => {
    await indexFromBody('shinji', follow(REI, ENGINEERING), 'create', 'rev1')

    expect(await boundariesOf('shinji')).toEqual([ENGINEERING])
    expect(await backlinksOf('shinji')).toEqual([
      { uri: uriOf('shinji'), path: 'subject', linkTo: REI },
    ])

    await indexFromBody('shinji', follow(KAWORU, LEADERSHIP), 'update', 'rev2')

    expect(await boundariesOf('shinji')).toEqual([LEADERSHIP])
    expect(await backlinksOf('shinji')).toEqual([
      { uri: uriOf('shinji'), path: 'subject', linkTo: KAWORU },
    ])
  })
})
