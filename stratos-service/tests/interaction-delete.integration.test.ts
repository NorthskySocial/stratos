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
  asMember,
  HARNESS_ENGINEERING,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type CallResult,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const DELETE = 'zone.stratos.repo.deleteRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'

const interaction = (collection: string, subject: unknown) => ({
  $type: collection,
  subject,
  createdAt: '1996-10-04T00:00:00.000Z',
})

type Remove = (
  harness: WriteHarness,
  collection: string,
  rkey: string,
) => Promise<CallResult>

const REMOVALS: Array<[string, Remove]> = [
  [
    'deleteRecord',
    (harness, collection, rkey) =>
      harness.call(DELETE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection,
        rkey,
      }),
  ],
  [
    'applyWrites #delete',
    (harness, collection, rkey) =>
      harness.call(APPLY_WRITES, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        writes: [{ $type: `${WRITE_TYPE}delete`, collection, rkey }],
      }),
  ],
]

function defineDeleteCases(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let subject: { uri: string; cid: string }

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    const created = await harness.call(CREATE, asMember(SHINJI), {
      boundary: HARNESS_ENGINEERING,
      repo: SHINJI,
      collection: POST,
      rkey: 'eva01',
      record: {
        $type: POST,
        text: 'sortie',
        createdAt: '1996-10-04T00:00:00.000Z',
      },
    })
    expect(created.status).toBe(200)
    subject = {
      uri: `at://${SHINJI}/${POST}/eva01`,
      cid: (created.body as { cid: string }).cid,
    }
  })

  const create = (collection: string, rkey: string) =>
    harness.call(CREATE, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      collection,
      rkey,
      record: interaction(collection, subject),
    })

  const backlinksTo = (collection: string, rkey: string) =>
    harness.ctx.actorStore.read(MISATO, (store) =>
      store.record
        .getRecordBacklinks({
          collection,
          path: 'subject.uri',
          linkTo: subject.uri,
        })
        .then((rows) => rows.filter((row) => row.rkey === rkey)),
    )

  describe.each(REMOVALS)('through %s', (_name, remove) => {
    it.each([LIKE, REPOST])(
      'removes a %s and its backlink, and the subject can be taken again',
      async (collection) => {
        expect((await create(collection, 'first')).status).toBe(200)
        const uri = `at://${MISATO}/${collection}/first`
        expect(await backlinksTo(collection, 'first')).toHaveLength(1)
        expect((await harness.recordRows(uri)).record).not.toBeNull()

        const removed = await remove(harness, collection, 'first')

        expect(removed.status).toBe(200)
        const rows = await harness.recordRows(uri)
        expect(rows.record).toBeNull()
        expect(rows.boundaries).toEqual([])
        expect(await backlinksTo(collection, 'first')).toEqual([])
        expect((await create(collection, 'second')).status).toBe(200)
      },
    )

    it('leaves a repost of the same subject when only the like goes', async () => {
      expect((await create(LIKE, 'first')).status).toBe(200)
      expect((await create(REPOST, 'first')).status).toBe(200)

      expect((await remove(harness, LIKE, 'first')).status).toBe(200)

      expect(
        (await harness.recordRows(`at://${MISATO}/${REPOST}/first`)).record,
      ).not.toBeNull()
      expect(await backlinksTo(REPOST, 'first')).toHaveLength(1)
    })
  })
}

describe('deleting an interaction on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineDeleteCases(() => harness)
})

describe('deleting an interaction on postgres', () => {
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

  defineDeleteCases(() => harness)
})
