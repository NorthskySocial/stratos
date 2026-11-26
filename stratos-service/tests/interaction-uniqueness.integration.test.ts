import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { formatRecordUri } from '@northskysocial/stratos-core'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type CallResult,
  type WriteHarness,
} from './helpers/write-harness.js'
import { startLabelRoute } from './helpers/label-route.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const PUT = 'zone.stratos.repo.putRecord'
const DELETE = 'zone.stratos.repo.deleteRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const DUPLICATE_MESSAGE =
  'The member already has this interaction with the subject'
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const ASUKA = 'did:plc:asuka-langley'

const repoUriOf = (author: string, collection: string, rkey: string) =>
  `at://${author}/${collection}/${rkey}`

function spaceUriOf(author: string, rkey: string): string {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: author,
    collection: POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

const interaction = (collection: string, subject: unknown) => ({
  $type: collection,
  subject,
  createdAt: '1996-10-04T00:00:00.000Z',
})

const duplicateRefusal = {
  error: 'RecordAlreadyExists',
  message: DUPLICATE_MESSAGE,
}

function defineUniquenessCases(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let subject: { uri: string; cid: string }

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
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
      uri: repoUriOf(SHINJI, POST, 'eva01'),
      cid: (created.body as { cid: string }).cid,
    }
  })

  const write = (
    procedure: string,
    collection: string,
    rkey: string,
    record: unknown,
  ): Promise<CallResult> =>
    harness.call(procedure, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      collection,
      rkey,
      record,
    })

  const create = (
    collection: string,
    rkey: string,
    target: unknown = subject,
  ) => write(CREATE, collection, rkey, interaction(collection, target))

  const stored = async (collection: string, rkey: string) =>
    (await harness.recordRows(repoUriOf(MISATO, collection, rkey))).record

  describe.each([LIKE, REPOST])('a second %s of one subject', (collection) => {
    it('is refused with RecordAlreadyExists and stores nothing', async () => {
      expect((await create(collection, 'first')).status).toBe(200)
      const rootBefore = await harness.repoRoot(MISATO)

      const second = await create(collection, 'second')

      expect(second.status).toBe(400)
      expect(second.body).toEqual(duplicateRefusal)
      expect(await stored(collection, 'second')).toBeNull()
      expect(await harness.repoRoot(MISATO)).toEqual(rootBefore)
    })

    it('is refused through applyWrites and putRecord alike', async () => {
      expect((await create(collection, 'first')).status).toBe(200)

      const viaPut = await write(
        PUT,
        collection,
        'second',
        interaction(collection, subject),
      )
      const viaBatch = await harness.call(APPLY_WRITES, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        writes: [
          {
            $type: `${WRITE_TYPE}create`,
            collection,
            rkey: 'third',
            value: interaction(collection, subject),
          },
        ],
      })

      expect(viaPut).toMatchObject({ status: 400, body: duplicateRefusal })
      expect(viaBatch).toMatchObject({ status: 400, body: duplicateRefusal })
    })

    it('is accepted again once the first is deleted', async () => {
      expect((await create(collection, 'first')).status).toBe(200)
      await harness.ctx.actorStore.transact(MISATO, (store) =>
        store.record.deleteRecord(repoUriOf(MISATO, collection, 'first')),
      )

      expect((await create(collection, 'second')).status).toBe(200)
    })
  })

  it('allows a like and a repost of one subject', async () => {
    expect((await create(LIKE, 'first')).status).toBe(200)

    expect((await create(REPOST, 'first')).status).toBe(200)
  })

  it('allows a like of a subject another member already liked', async () => {
    expect((await create(LIKE, 'first')).status).toBe(200)

    const other = await harness.call(CREATE, asMember(SHINJI), {
      boundary: HARNESS_ENGINEERING,
      repo: SHINJI,
      collection: LIKE,
      rkey: 'first',
      record: interaction(LIKE, subject),
    })

    expect(other.status).toBe(200)
  })

  describe('a put', () => {
    it('of the same rkey with the same subject is not a conflict', async () => {
      expect((await create(LIKE, 'first')).status).toBe(200)

      const again = await write(PUT, LIKE, 'first', interaction(LIKE, subject))

      expect(again.status).toBe(200)
    })

    it('of a new rkey with the same subject is refused', async () => {
      expect((await create(LIKE, 'first')).status).toBe(200)

      const other = await write(PUT, LIKE, 'second', interaction(LIKE, subject))

      expect(other).toMatchObject({ status: 400, body: duplicateRefusal })
    })
  })

  describe('a batch', () => {
    const batchOf = (...writes: Array<{ collection: string; rkey: string }>) =>
      harness.call(APPLY_WRITES, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        writes: writes.map(({ collection, rkey }) => ({
          $type: `${WRITE_TYPE}create`,
          collection,
          rkey,
          value: interaction(collection, subject),
        })),
      })

    it('with two likes of one subject is refused and stores nothing', async () => {
      const rootBefore = await harness.repoRoot(MISATO)

      const response = await batchOf(
        { collection: LIKE, rkey: 'first' },
        { collection: LIKE, rkey: 'second' },
      )

      expect(response).toMatchObject({ status: 400, body: duplicateRefusal })
      expect(await stored(LIKE, 'first')).toBeNull()
      expect(await stored(LIKE, 'second')).toBeNull()
      expect(await harness.repoRoot(MISATO)).toEqual(rootBefore)
    })

    it('that deletes a like and creates another of its subject is accepted', async () => {
      expect((await create(LIKE, 'first')).status).toBe(200)

      const response = await harness.call(APPLY_WRITES, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        writes: [
          { $type: `${WRITE_TYPE}delete`, collection: LIKE, rkey: 'first' },
          {
            $type: `${WRITE_TYPE}create`,
            collection: LIKE,
            rkey: 'second',
            value: interaction(LIKE, subject),
          },
        ],
      })

      expect(response.status).toBe(200)
      expect(await stored(LIKE, 'first')).toBeNull()
      expect(await stored(LIKE, 'second')).not.toBeNull()
    })

    it('with a like and a repost of one subject is accepted', async () => {
      const response = await batchOf(
        { collection: LIKE, rkey: 'first' },
        { collection: REPOST, rkey: 'first' },
      )

      expect(response.status).toBe(200)
    })
  })

  describe('a space-form subject', () => {
    it('is refused the second time', async () => {
      const target = { uri: spaceUriOf(ASUKA, 'eva02'), cid: subject.cid }
      expect((await create(LIKE, 'first', target)).status).toBe(200)

      const second = await create(LIKE, 'second', target)

      expect(second).toMatchObject({ status: 400, body: duplicateRefusal })
    })

    it('does not clash with the repo-form subject of another post', async () => {
      const target = { uri: spaceUriOf(ASUKA, 'eva02'), cid: subject.cid }
      expect((await create(LIKE, 'first', target)).status).toBe(200)

      expect((await create(LIKE, 'second')).status).toBe(200)
    })
  })

  it('lets exactly one of two concurrent creates through', async () => {
    const responses = await Promise.all([
      create(LIKE, 'first'),
      create(LIKE, 'second'),
    ])

    const statuses = responses.map((response) => response.status).sort()
    expect(statuses).toEqual([200, 400])
    const refused = responses.find((response) => response.status === 400)
    expect(refused?.body).toEqual(duplicateRefusal)
    const kept = [await stored(LIKE, 'first'), await stored(LIKE, 'second')]
    expect(kept.filter((row) => row !== null)).toHaveLength(1)
  })

  it('still counts a taken-down like', async () => {
    expect((await create(LIKE, 'first')).status).toBe(200)
    const labels = await startLabelRoute(harness)
    try {
      expect(
        await labels.takeDownRecord(repoUriOf(MISATO, LIKE, 'first')),
      ).toBe(200)
    } finally {
      await labels.close()
    }

    const second = await create(LIKE, 'second')

    expect(second).toMatchObject({ status: 400, body: duplicateRefusal })
  })

  it('accepts a new like once the first was deleted through the service', async () => {
    expect((await create(LIKE, 'first')).status).toBe(200)
    const removed = await harness.call(DELETE, asMember(MISATO), {
      boundary: HARNESS_ENGINEERING,
      repo: MISATO,
      collection: LIKE,
      rkey: 'first',
    })
    expect(removed.status).toBe(200)

    expect((await create(LIKE, 'second')).status).toBe(200)
  })
}

describe('one interaction per subject on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineUniquenessCases(() => harness)
})

describe('one interaction per subject on postgres', () => {
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

  defineUniquenessCases(() => harness)
})
