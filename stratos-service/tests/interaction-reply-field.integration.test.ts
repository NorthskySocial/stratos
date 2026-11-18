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
const PUT = 'zone.stratos.repo.putRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const ASUKA = 'did:plc:asuka-langley'
const GENDO = 'did:plc:gendo-ikari'
const PARENT_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'

type ValidateField = { validate?: boolean }

const VALIDATE_MODES: ValidateField[] = [
  { validate: false },
  {},
  { validate: true },
]

type Sender = (
  harness: WriteHarness,
  member: string,
  collection: string,
  rkey: string,
  record: unknown,
  fields: ValidateField,
) => Promise<CallResult>

const SENDERS: Array<{ name: string; send: Sender }> = [
  {
    name: 'createRecord',
    send: (harness, member, collection, rkey, record, fields) =>
      harness.call(CREATE, asMember(member), {
        boundary: HARNESS_ENGINEERING,
        repo: member,
        collection,
        rkey,
        record,
        ...fields,
      }),
  },
  {
    name: 'putRecord',
    send: (harness, member, collection, rkey, record, fields) =>
      harness.call(PUT, asMember(member), {
        boundary: HARNESS_ENGINEERING,
        repo: member,
        collection,
        rkey,
        record,
        ...fields,
      }),
  },
  {
    name: 'applyWrites #create',
    send: (harness, member, collection, rkey, record, fields) =>
      harness.call(APPLY_WRITES, asMember(member), {
        boundary: HARNESS_ENGINEERING,
        repo: member,
        writes: [
          { $type: `${WRITE_TYPE}create`, collection, rkey, value: record },
        ],
        ...fields,
      }),
  },
  {
    name: 'applyWrites #update',
    send: async (harness, member, collection, rkey, record, fields) => {
      await harness.call(CREATE, asMember(member), {
        boundary: HARNESS_ENGINEERING,
        repo: member,
        collection,
        rkey,
        record: {
          $type: collection,
          subject: (record as { subject: unknown }).subject,
          createdAt: '1996-10-04T00:00:00.000Z',
        },
        validate: false,
      })
      return harness.call(APPLY_WRITES, asMember(member), {
        boundary: HARNESS_ENGINEERING,
        repo: member,
        writes: [
          { $type: `${WRITE_TYPE}update`, collection, rkey, value: record },
        ],
        ...fields,
      })
    },
  },
]

function defineReplyOnInteractions(getHarness: () => WriteHarness) {
  describe.each([LIKE, REPOST])('a %s that carries a reply', (collection) => {
    let harness: WriteHarness
    let subject: { uri: string; cid: string }

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await harness.enrollMember(ASUKA, [HARNESS_ENGINEERING])
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

    const withReply = (parentUri: string) => ({
      $type: collection,
      subject,
      createdAt: '1996-10-04T00:00:00.000Z',
      reply: {
        root: { uri: parentUri, cid: PARENT_CID },
        parent: { uri: parentUri, cid: PARENT_CID },
      },
    })

    const withoutReply = () => ({
      $type: collection,
      subject,
      createdAt: '1996-10-04T00:00:00.000Z',
    })

    const parents = [
      { name: 'an author with no actor store', author: GENDO, rkey: 'eva00' },
      { name: 'an existing post', author: SHINJI, rkey: 'eva01' },
    ]

    describe.each(SENDERS)('through $name', (sender) => {
      describe.each(parents)('naming $name as parent', (parent) => {
        it.each(VALIDATE_MODES)(
          'is answered as the same like without a reply, validate %o',
          async (fields) => {
            const parentUri = `at://${parent.author}/${POST}/${parent.rkey}`

            const plain = await sender.send(
              harness,
              MISATO,
              collection,
              'eva-plain',
              withoutReply(),
              fields,
            )
            const replying = await sender.send(
              harness,
              ASUKA,
              collection,
              'eva-reply',
              withReply(parentUri),
              fields,
            )

            expect(plain.status).toBe(200)
            expect(replying.status).toBe(plain.status)
          },
        )
      })
    })
  })
}

describe('a reply on a like or repost on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineReplyOnInteractions(() => harness)
})

describe('a reply on a like or repost on postgres', () => {
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

  defineReplyOnInteractions(() => harness)
})
