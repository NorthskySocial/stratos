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
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const MISATO = 'did:plc:misato-katsuragi'
const ASUKA = 'did:plc:asuka-langley'
const FAYE = 'did:plc:faye-valentine'
const POST_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const SUBJECT_ERROR = 'The subject must be a post in this boundary'
const SUBJECT_BODY = { error: 'InvalidRecord', message: SUBJECT_ERROR }
const DUPLICATE_BODY = {
  error: 'RecordAlreadyExists',
  message: 'The member already has this interaction with the subject',
}
const NOT_A_URI = 'spike spiegel'
const CREATED_AT = '1998-10-24T00:00:00.000Z'
const VALIDATION_ON: Array<{ validate?: boolean }> = [{}, { validate: true }]
const VALIDATION_ANY: Array<{ validate?: boolean }> = [
  ...VALIDATION_ON,
  { validate: false },
]

function spaceRecordUri(
  author: string,
  rkey: string,
  overrides: { authority?: string; skey?: string } = {},
): string {
  const formatted = formatRecordUri({
    spaceDid: overrides.authority ?? HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: overrides.skey ?? 'engineering',
    authorDid: author,
    collection: POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

/** The old spelling of a record's space URI, built from the same parts. */
const LEGACY_SPACE_PREFIX = `at://${HARNESS_SERVICE_DID}/space/${HOSTED_SPACE_TYPE}/engineering`

function legacySpellingOf(author: string, rkey: string): string {
  return `${LEGACY_SPACE_PREFIX}/${author}/${POST}/${rkey}`
}

const interaction = (collection: string, subject: unknown) => ({
  $type: collection,
  subject,
  createdAt: CREATED_AT,
})

const postWith = (extra: Record<string, unknown>) => ({
  $type: POST,
  text: 'Tank!',
  createdAt: CREATED_AT,
  ...extra,
})

const replyTo = (parent: string, root: string) => ({
  reply: {
    parent: { uri: parent, cid: POST_CID },
    root: { uri: root, cid: POST_CID },
  },
})

const embedOf = (uri: string) => ({
  embed: {
    $type: 'app.bsky.embed.record',
    record: { uri, cid: POST_CID },
  },
})

function defineRecordPathCases(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let counter = 0

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const nextRkey = () => `bebop-${counter++}`

  const create = (
    collection: string,
    record: unknown,
    fields: { validate?: boolean } = {},
  ): Promise<CallResult & { rkey: string }> => {
    const rkey = nextRkey()
    return harness
      .call(CREATE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection,
        rkey,
        record,
        ...fields,
      })
      .then((result) => ({ ...result, rkey }))
  }

  const storedValue = async (collection: string, rkey: string) =>
    (await harness.recordRows(`at://${MISATO}/${collection}/${rkey}`)).record
      ?.value as Record<string, unknown> | undefined

  const backlinksTo = (collection: string, linkTo: string) =>
    harness.ctx.actorStore.read(MISATO, (store) =>
      store.record.getRecordBacklinks({
        collection,
        path: 'subject.uri',
        linkTo,
      }),
    )

  describe('a post that names space records', () => {
    const parent = spaceRecordUri(ASUKA, 'swordfish')
    const root = spaceRecordUri(ASUKA, 'bebop')
    const embedded = spaceRecordUri(ASUKA, 'hammerhead')

    it.each(VALIDATION_ON)(
      'is accepted with validation %j and stores the three URIs as sent',
      async (fields) => {
        const sent = postWith({
          ...replyTo(parent, root),
          ...embedOf(embedded),
        })

        const response = await create(POST, sent, fields)

        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ validationStatus: 'valid' })
        const stored = await storedValue(POST, response.rkey)
        const reply = stored?.reply as {
          parent: { uri: string }
          root: { uri: string }
        }
        const embed = stored?.embed as { record: { uri: string } }
        expect(reply.parent.uri).toBe(parent)
        expect(reply.root.uri).toBe(root)
        expect(embed.record.uri).toBe(embedded)
      },
    )

    it('is accepted without validation and stores the three URIs as sent', async () => {
      const sent = postWith({ ...replyTo(parent, root), ...embedOf(embedded) })

      const response = await create(POST, sent, { validate: false })

      expect(response.status).toBe(200)
      const stored = await storedValue(POST, response.rkey)
      expect(stored).toMatchObject({
        reply: { parent: { uri: parent }, root: { uri: root } },
        embed: { record: { uri: embedded } },
      })
    })

    it('is refused when the reply parent is in a boundary the writer is not posting to', async () => {
      const response = await create(
        POST,
        postWith(
          replyTo(spaceRecordUri(ASUKA, 'swordfish', { skey: 'design' }), root),
        ),
        { validate: false },
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRecord' })
    })
  })

  describe('a post that embeds a bsky record the strict parser does not read', () => {
    it('is refused without validation when the scheme is upper-case', async () => {
      const response = await create(
        POST,
        postWith(embedOf(`AT://${ASUKA}/app.bsky.feed.post/3k`)),
        { validate: false },
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRecord' })
      expect(await storedValue(POST, response.rkey)).toBeUndefined()
    })
  })

  describe('a post that names a space record in the old spelling', () => {
    const legacyParent = legacySpellingOf(ASUKA, 'swordfish')
    const root = spaceRecordUri(ASUKA, 'bebop')

    it.each(VALIDATION_ANY)(
      'is refused as a reply parent with validation %j, and no store is read for it',
      async (fields) => {
        const reads = vi.spyOn(harness.ctx.actorStore, 'read')

        const response = await create(
          POST,
          postWith(replyTo(legacyParent, root)),
          fields,
        )

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'InvalidRecord' })
        expect(reads.mock.calls.map(([did]) => did)).not.toContain(
          HARNESS_SERVICE_DID,
        )
        expect(await storedValue(POST, response.rkey)).toBeUndefined()
      },
    )

    it.each(VALIDATION_ANY)(
      'is refused as a reply root with validation %j',
      async (fields) => {
        const response = await create(
          POST,
          postWith(replyTo(root, legacyParent)),
          fields,
        )

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'InvalidRecord' })
      },
    )

    it.each(VALIDATION_ANY)(
      'is refused as a reply parent that is not a URI with validation %j',
      async (fields) => {
        const response = await create(
          POST,
          postWith(replyTo(NOT_A_URI, root)),
          fields,
        )

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'InvalidRecord' })
      },
    )

    it.each(VALIDATION_ON)(
      'is refused as an embed with validation %j by the lexicon check',
      async (fields) => {
        const response = await create(
          POST,
          postWith(embedOf(legacySpellingOf(ASUKA, 'hammerhead'))),
          fields,
        )

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({ error: 'InvalidRecord' })
      },
    )

    it('is stored byte-equal as an embed without validation, as a plain non-URI string is', async () => {
      const legacyEmbed = legacySpellingOf(ASUKA, 'hammerhead')

      const legacy = await create(POST, postWith(embedOf(legacyEmbed)), {
        validate: false,
      })
      const control = await create(POST, postWith(embedOf(NOT_A_URI)), {
        validate: false,
      })

      expect(legacy.status).toBe(200)
      expect(control.status).toBe(200)
      expect(await storedValue(POST, legacy.rkey)).toMatchObject({
        embed: { record: { uri: legacyEmbed } },
      })
      expect(await storedValue(POST, control.rkey)).toMatchObject({
        embed: { record: { uri: NOT_A_URI } },
      })
    })

    it.each(VALIDATION_ON)(
      'is refused as an embed that is not a URI with validation %j, the same way',
      async (fields) => {
        const legacy = await create(
          POST,
          postWith(embedOf(legacySpellingOf(ASUKA, 'hammerhead'))),
          fields,
        )
        const control = await create(POST, postWith(embedOf(NOT_A_URI)), fields)

        expect(control.status).toBe(legacy.status)
        expect(control.body).toMatchObject({ error: 'InvalidRecord' })
      },
    )
  })

  describe.each([LIKE, REPOST])('a %s of a space record', (collection) => {
    const subject = { uri: spaceRecordUri(ASUKA, 'swordfish'), cid: POST_CID }

    it.each(VALIDATION_ON)(
      'is accepted with validation %j and keeps the subject URI and its backlink key as sent',
      async (fields) => {
        const response = await create(
          collection,
          interaction(collection, subject),
          fields,
        )

        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ validationStatus: 'valid' })
        const stored = await storedValue(collection, response.rkey)
        expect((stored?.subject as { uri: string }).uri).toBe(subject.uri)
        const linked = await backlinksTo(collection, subject.uri)
        expect(linked.map((row) => row.uri)).toEqual([
          `at://${MISATO}/${collection}/${response.rkey}`,
        ])
      },
    )

    it('is found under no key but the submitted string', async () => {
      const response = await create(
        collection,
        interaction(collection, subject),
      )
      expect(response.status).toBe(200)

      const byOtherSpelling = await backlinksTo(
        collection,
        legacySpellingOf(ASUKA, 'swordfish'),
      )
      const byOtherRecord = await backlinksTo(
        collection,
        spaceRecordUri(ASUKA, 'bebop'),
      )

      expect(byOtherSpelling).toEqual([])
      expect(byOtherRecord).toEqual([])
    })

    it('is refused the second time', async () => {
      expect(
        (await create(collection, interaction(collection, subject))).status,
      ).toBe(200)

      const second = await create(collection, interaction(collection, subject))

      expect(second.status).toBe(400)
      expect(second.body).toEqual(DUPLICATE_BODY)
    })

    it('is refused when a batch names the subject twice, and stores nothing', async () => {
      const response = await harness.call(APPLY_WRITES, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        writes: ['first', 'second'].map((rkey) => ({
          $type: `${WRITE_TYPE}create`,
          collection,
          rkey,
          value: interaction(collection, subject),
        })),
      })

      expect(response.status).toBe(400)
      expect(response.body).toEqual(DUPLICATE_BODY)
      expect(await backlinksTo(collection, subject.uri)).toEqual([])
    })
  })

  describe.each([LIKE, REPOST])(
    'a %s of a space record that is spelled wrongly',
    (collection) => {
      const wrong: Array<[string, string]> = [
        ['the old spelling', legacySpellingOf(ASUKA, 'swordfish')],
        [
          'the authority and the author swapped',
          spaceRecordUri(HARNESS_SERVICE_DID, 'swordfish', {
            authority: ASUKA,
          }),
        ],
        ['a seventh part', `${spaceRecordUri(ASUKA, 'swordfish')}/${FAYE}`],
        ['a query suffix', `${spaceRecordUri(ASUKA, 'swordfish')}?x`],
      ]

      it.each(wrong)(
        'is refused with the subject error for %s, under every validate value',
        async (_name, uri) => {
          for (const fields of VALIDATION_ANY) {
            const response = await create(
              collection,
              interaction(collection, { uri, cid: POST_CID }),
              fields,
            )

            expect(response.status).toBe(400)
            expect(response.body).toEqual(SUBJECT_BODY)
            expect(await backlinksTo(collection, uri)).toEqual([])
          }
        },
      )
    },
  )

  describe('rows an earlier spelling left behind', () => {
    const legacySubject = legacySpellingOf(ASUKA, 'swordfish')
    const subject = { uri: spaceRecordUri(ASUKA, 'swordfish'), cid: POST_CID }

    async function leaveBacklinkUnderLegacySpelling(): Promise<string> {
      const earlier = await create(LIKE, interaction(LIKE, subject))
      expect(earlier.status).toBe(200)
      const likeUri = `at://${MISATO}/${LIKE}/${earlier.rkey}`
      await harness.ctx.actorStore.transact(MISATO, async (store) => {
        await store.record.removeBacklinksByUri(likeUri)
        await store.record.addBacklinks([
          { uri: likeUri, path: 'subject.uri', linkTo: legacySubject },
        ])
      })
      return likeUri
    }

    it('lets a like of the same post in the new form in, and never matches the old row', async () => {
      const earlierLike = await leaveBacklinkUnderLegacySpelling()

      const later = await create(LIKE, interaction(LIKE, subject))

      expect(later.status).toBe(200)
      const byNew = await backlinksTo(LIKE, subject.uri)
      expect(byNew.map((row) => row.uri)).toEqual([
        `at://${MISATO}/${LIKE}/${later.rkey}`,
      ])
      const byLegacy = await backlinksTo(LIKE, legacySubject)
      expect(byLegacy.map((row) => row.uri)).toEqual([earlierLike])
    })

    it('leaves the old backlink and the old like as they were', async () => {
      const earlierLike = await leaveBacklinkUnderLegacySpelling()
      const before = await harness.recordRows(earlierLike)

      await create(LIKE, interaction(LIKE, subject))

      const after = await harness.recordRows(earlierLike)
      expect(after.record?.cid).toBe(before.record?.cid)
      expect(
        (await backlinksTo(LIKE, legacySubject)).map((row) => row.uri),
      ).toEqual([earlierLike])
    })
  })
}

describe('space records in the record path on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  defineRecordPathCases(() => harness)
})

describe('space records in the record path on postgres', () => {
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

  defineRecordPathCases(() => harness)
})
