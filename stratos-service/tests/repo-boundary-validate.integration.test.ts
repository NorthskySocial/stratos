import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import * as fc from 'fast-check'
import { jsonToLex } from '@atproto/lexicon'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { applyBoundaryWrites } from '../src/api/records/boundary-writes.js'
import {
  requireLexiconValidation,
  skipLexiconValidation,
  validateIfKnown,
} from '../src/api/records/lexicon-validation.js'
import {
  asMember,
  HARNESS_DESIGN,
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

const PILOT = 'did:plc:shinji-ikari'
const MENTOR = 'did:plc:misato-katsuragi'
const COLLECTION = 'zone.stratos.feed.post'
const UNLISTED_COLLECTION = 'zone.stratos.feed.angel'
const BLOB_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const POST_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const WRITE_TYPE = 'zone.stratos.repo.applyWrites#'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const CREATE = 'zone.stratos.repo.createRecord'
const PUT = 'zone.stratos.repo.putRecord'
const LEGACY_CREATE = 'com.atproto.repo.createRecord'
const OVER_TEXT_LIMIT = 'a'.repeat(3001)
const LEGACY_BODY_LIMIT_BYTES = 100 * 1024
const NEW_BODY_LIMIT_BYTES = 1_000_000
const BATCH_SIZE = 200

const uriOf = (rkey: string) => `at://${PILOT}/${COLLECTION}/${rkey}`

function post(text: string, extra: Record<string, unknown> = {}) {
  return {
    $type: COLLECTION,
    text,
    createdAt: '1996-10-04T00:00:00.000Z',
    ...extra,
  }
}

const strongRef = (rkey: string) => ({ uri: uriOf(rkey), cid: POST_CID })

const blob = (mimeType: string, size = 1200) => ({
  $type: 'blob',
  ref: { $link: BLOB_CID },
  mimeType,
  size,
})

const aspectRatio = { width: 1920, height: 1080 }

const embeddedImages = {
  $type: 'app.bsky.embed.images',
  images: [{ image: blob('image/png'), alt: 'Unit 01', aspectRatio }],
}

const embeddedRecord = (rkey: string) => ({
  $type: 'app.bsky.embed.record',
  record: strongRef(rkey),
})

type ValidateField = { validate?: boolean }

const VALIDATE_MODES: Array<{ name: string; fields: ValidateField }> = [
  { name: 'false', fields: { validate: false } },
  { name: 'absent', fields: {} },
  { name: 'true', fields: { validate: true } },
]

interface Procedure {
  name: string
  /** Sends one post as the pilot and returns the status the write reported. */
  send(
    harness: WriteHarness,
    record: unknown,
    fields: ValidateField,
  ): Promise<CallResult>
  statusOf(body: unknown): unknown
}

const writeEntry = (record: unknown) => ({
  $type: `${WRITE_TYPE}create`,
  collection: COLLECTION,
  rkey: 'eva00',
  value: record,
})

const PROCEDURES: Procedure[] = [
  {
    name: 'createRecord',
    send: (harness, record, fields) =>
      harness.call(CREATE, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record,
        ...fields,
      }),
    statusOf: (body) =>
      (body as { validationStatus?: unknown }).validationStatus,
  },
  {
    name: 'putRecord',
    send: (harness, record, fields) =>
      harness.call(PUT, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record,
        ...fields,
      }),
    statusOf: (body) =>
      (body as { validationStatus?: unknown }).validationStatus,
  },
  {
    name: 'applyWrites',
    send: (harness, record, fields) =>
      harness.call(APPLY_WRITES, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: [writeEntry(record)],
        ...fields,
      }),
    statusOf: (body) =>
      (body as { results: Array<{ validationStatus?: unknown }> }).results[0]
        .validationStatus,
  },
]

async function enrollPilot(harness: WriteHarness) {
  await harness.enrollMember(PILOT, [HARNESS_ENGINEERING])
}

async function seedPost(harness: WriteHarness, rkey: string) {
  const seeded = await harness.call(CREATE, asMember(PILOT), {
    boundary: HARNESS_ENGINEERING,
    repo: PILOT,
    collection: COLLECTION,
    rkey,
    record: post(`seed ${rkey}`),
    validate: false,
  })
  expect(seeded.status).toBe(200)
}

function defineValidateMatrix(getHarness: () => WriteHarness) {
  describe.each(PROCEDURES)('$name', (procedure) => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
    })

    describe.each(VALIDATE_MODES)('with validate $name', ({ fields }) => {
      const validates = fields.validate !== false

      it('stores a valid post and reports its status only when it validated', async () => {
        const response = await procedure.send(harness, post('Sortie'), fields)

        expect(response.status).toBe(200)
        expect(procedure.statusOf(response.body)).toBe(
          validates ? 'valid' : undefined,
        )
        expect((await harness.recordRows(uriOf('eva00'))).record).not.toBeNull()
      })

      it('judges a post over the text limit by the validate field', async () => {
        const response = await procedure.send(
          harness,
          post(OVER_TEXT_LIMIT),
          fields,
        )

        if (!validates) {
          expect(response.status).toBe(200)
          expect(procedure.statusOf(response.body)).toBeUndefined()
          return
        }
        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({
          error: 'InvalidRecord',
          message: expect.stringContaining(COLLECTION),
        })
        expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
        expect(await harness.sequencedOps(PILOT)).toEqual([])
      })
    })
  })
}

const TYPE_FAULTS: Array<
  [string, (record: Record<string, unknown>) => unknown, string]
> = [
  ['no type', ({ $type: _type, ...rest }) => rest, 'none'],
  [
    'a type of another collection',
    (record) => ({ ...record, $type: 'app.bsky.feed.post' }),
    'app.bsky.feed.post',
  ],
]

function defineTypeRefusals(getHarness: () => WriteHarness) {
  describe.each(PROCEDURES)('$name with validate false', (procedure) => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
    })

    it.each(TYPE_FAULTS)(
      'still refuses a record with %s',
      async (_name, fault, found) => {
        const response = await procedure.send(harness, fault(post('Sortie')), {
          validate: false,
        })

        expect(response.status).toBe(400)
        expect(response.body).toEqual({
          error: 'InvalidRecord',
          message: `The record $type (${found}) must equal its collection ${COLLECTION}`,
        })
        expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
      },
    )
  })
}

function defineEmbedCases(getHarness: () => WriteHarness) {
  describe('records that need the upstream definitions', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
      await seedPost(harness, 'eva-op')
    })

    const CASES: Array<[string, () => Record<string, unknown>]> = [
      [
        'a post with facets',
        () => ({
          facets: [
            {
              index: { byteStart: 0, byteEnd: 6 },
              features: [
                { $type: 'app.bsky.richtext.facet#mention', did: MENTOR },
              ],
            },
          ],
        }),
      ],
      [
        'a reply',
        () => ({
          reply: { root: strongRef('eva-op'), parent: strongRef('eva-op') },
        }),
      ],
      [
        'self labels',
        () => ({
          labels: {
            $type: 'com.atproto.label.defs#selfLabels',
            values: [{ val: 'graphic-media' }],
          },
        }),
      ],
      [
        'a stratos image embed',
        () => ({
          embed: {
            $type: 'zone.stratos.embed.images',
            images: [{ image: blob('image/png'), alt: 'Unit 02' }],
          },
        }),
      ],
      ['an image embed', () => ({ embed: embeddedImages })],
      [
        'a video embed',
        () => ({
          embed: {
            $type: 'app.bsky.embed.video',
            video: blob('video/mp4', 4_000_000),
            aspectRatio,
          },
        }),
      ],
      [
        'an external embed',
        () => ({
          embed: {
            $type: 'app.bsky.embed.external',
            external: {
              uri: 'https://nerv.tokyo.jp/magi',
              title: 'MAGI',
              description: 'Three supercomputers',
              thumb: blob('image/jpeg'),
            },
          },
        }),
      ],
      ['a record embed', () => ({ embed: embeddedRecord('eva-op') })],
      [
        'a record with image media',
        () => ({
          embed: {
            $type: 'app.bsky.embed.recordWithMedia',
            record: embeddedRecord('eva-op'),
            media: embeddedImages,
          },
        }),
      ],
      [
        'a record with gallery media',
        () => ({
          embed: {
            $type: 'app.bsky.embed.recordWithMedia',
            record: embeddedRecord('eva-op'),
            media: {
              $type: 'app.bsky.embed.gallery',
              items: [
                {
                  $type: 'app.bsky.embed.gallery#image',
                  image: blob('image/png'),
                  alt: 'Unit 05',
                  aspectRatio,
                },
              ],
            },
          },
        }),
      ],
    ]

    it.each(CASES)('validates %s', async (_name, extra) => {
      const response = await harness.call(CREATE, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva01',
        record: post('Sortie', extra()),
      })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        uri: uriOf('eva01'),
        cid: expect.any(String),
        validationStatus: 'valid',
      })
    })
  })
}

function defineApplyWritesStatuses(getHarness: () => WriteHarness) {
  describe('applyWrites statuses', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
      await seedPost(harness, 'eva-old')
      await seedPost(harness, 'eva-gone')
    })

    const mixedWrites = () => [
      writeEntry(post('Sortie')),
      {
        $type: `${WRITE_TYPE}update`,
        collection: COLLECTION,
        rkey: 'eva-old',
        value: post('Berserk'),
      },
      {
        $type: `${WRITE_TYPE}delete`,
        collection: COLLECTION,
        rkey: 'eva-gone',
      },
    ]

    it('reports a status for each create and update and none for a delete', async () => {
      const response = await harness.call(APPLY_WRITES, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: mixedWrites(),
      })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        results: [
          {
            $type: `${WRITE_TYPE}createResult`,
            uri: uriOf('eva00'),
            cid: expect.any(String),
            validationStatus: 'valid',
          },
          {
            $type: `${WRITE_TYPE}updateResult`,
            uri: uriOf('eva-old'),
            cid: expect.any(String),
            validationStatus: 'valid',
          },
          { $type: `${WRITE_TYPE}deleteResult` },
        ],
      })
    })

    it('reports no status for any write when validate is false', async () => {
      const response = await harness.call(APPLY_WRITES, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: mixedWrites(),
        validate: false,
      })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        results: [
          {
            $type: `${WRITE_TYPE}createResult`,
            uri: uriOf('eva00'),
            cid: expect.any(String),
          },
          {
            $type: `${WRITE_TYPE}updateResult`,
            uri: uriOf('eva-old'),
            cid: expect.any(String),
          },
          { $type: `${WRITE_TYPE}deleteResult` },
        ],
      })
    })

    it('refuses the whole batch when one post is over the limit', async () => {
      const before = await harness.repoRoot(PILOT)

      const response = await harness.call(APPLY_WRITES, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: [
          writeEntry(post('Sortie')),
          {
            $type: `${WRITE_TYPE}update`,
            collection: COLLECTION,
            rkey: 'eva-old',
            value: post(OVER_TEXT_LIMIT),
          },
        ],
      })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'InvalidRecord',
        message: expect.stringContaining(COLLECTION),
      })
      expect(await harness.repoRoot(PILOT)).toEqual(before)
    })
  })
}

function defineBodyLimits(getHarness: () => WriteHarness) {
  describe('request body limits', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
    })

    // 280 characters and eight 64-character tags keep each post valid at
    // roughly 900 bytes, so 200 of them are well past the legacy limit.
    const weightyPost = (index: number) =>
      post(`${'a'.repeat(270)} ${index}`, {
        tags: Array.from({ length: 8 }, (_, tag) => `${'t'.repeat(60)}${tag}`),
      })

    it('accepts a batch of 200 posts that is over the legacy limit', async () => {
      const body = {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        writes: Array.from({ length: BATCH_SIZE }, (_, index) => ({
          $type: `${WRITE_TYPE}create`,
          collection: COLLECTION,
          rkey: `eva${index}`,
          value: weightyPost(index),
        })),
      }
      const size = Buffer.byteLength(JSON.stringify(body))
      expect(size).toBeGreaterThan(LEGACY_BODY_LIMIT_BYTES)
      expect(size).toBeLessThan(NEW_BODY_LIMIT_BYTES)

      const response = await harness.call(APPLY_WRITES, asMember(PILOT), body)

      expect(response.status).toBe(200)
      expect((response.body as { results: unknown[] }).results).toHaveLength(
        BATCH_SIZE,
      )
    })

    it('answers 413 to a createRecord body over 1,000,000 bytes', async () => {
      const response = await harness.call(CREATE, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record: post('a'.repeat(NEW_BODY_LIMIT_BYTES + 1)),
      })

      expect(response.status).toBe(413)
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })

    it('keeps the legacy limit: a legacy createRecord of about 150 kb is 413', async () => {
      const response = await harness.call(LEGACY_CREATE, asMember(PILOT), {
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record: post('a'.repeat(150 * 1024), {
          boundary: {
            $type: 'zone.stratos.boundary.defs#Domains',
            values: [{ value: HARNESS_ENGINEERING }],
          },
        }),
      })

      expect(response.status).toBe(413)
    })
  })
}

function defineLegacyLeniency(getHarness: () => WriteHarness) {
  describe('legacy entry points', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
    })

    const claim = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: HARNESS_ENGINEERING }],
    }

    it('accepts a lexicon-invalid post on createRecord without a status', async () => {
      const response = await harness.call(LEGACY_CREATE, asMember(PILOT), {
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva00',
        record: post(OVER_TEXT_LIMIT, { boundary: claim }),
      })

      expect(response.status).toBe(200)
      expect(response.body).not.toHaveProperty('validationStatus')
      expect((await harness.recordRows(uriOf('eva00'))).record).not.toBeNull()
    })
  })
}

function defineDirectCalls(getHarness: () => WriteHarness) {
  describe('a direct pipeline call', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
    })

    const withImage = () =>
      post('Sortie', {
        embed: {
          $type: 'app.bsky.embed.images',
          images: [{ image: blob('image/png'), alt: 'Unit 01', aspectRatio }],
        },
      })

    const createFor = (rkey: string, record: unknown) => [
      { kind: 'create' as const, collection: COLLECTION, rkey, record },
    ]

    it('reports the status an http call reports for the same lex-form record', async () => {
      const http = await harness.call(CREATE, asMember(PILOT), {
        boundary: HARNESS_ENGINEERING,
        repo: PILOT,
        collection: COLLECTION,
        rkey: 'eva-http',
        record: withImage(),
      })

      const direct = await applyBoundaryWrites(
        harness.ctx,
        PILOT,
        HARNESS_ENGINEERING,
        createFor('eva-direct', jsonToLex(withImage())),
      )

      expect(direct.results[0].validationStatus).toBe('valid')
      expect(
        (http.body as { validationStatus?: string }).validationStatus,
      ).toBe('valid')
    })

    it('expects lex form: a blob in JSON form is refused as invalid', async () => {
      await expect(
        applyBoundaryWrites(
          harness.ctx,
          PILOT,
          HARNESS_ENGINEERING,
          createFor('eva-json', withImage()),
        ),
      ).rejects.toMatchObject({
        customErrorName: 'InvalidRecord',
        message: expect.stringContaining(COLLECTION),
      })
    })

    it('skips the lexicon check when handed the skipping strategy', async () => {
      const outcome = await applyBoundaryWrites(
        harness.ctx,
        PILOT,
        HARNESS_ENGINEERING,
        createFor('eva-skip', post(OVER_TEXT_LIMIT)),
        skipLexiconValidation,
      )

      expect(outcome.results[0].validationStatus).toBeUndefined()
    })
  })
}

const MALFORMED_TYPES = ['a#b#c', '#x']

/** Puts a union member with the given `$type` where a post carries a union. */
const UNION_SLOTS: Array<
  [string, (member: unknown) => Record<string, unknown>]
> = [
  ['embed', (member) => ({ embed: member })],
  ['labels', (member) => ({ labels: member })],
  [
    'a facet feature',
    (member) => ({
      facets: [{ index: { byteStart: 0, byteEnd: 3 }, features: [member] }],
    }),
  ],
  [
    'the media of a recordWithMedia embed',
    (member) => ({
      embed: {
        $type: 'app.bsky.embed.recordWithMedia',
        record: embeddedRecord('eva-op'),
        media: member,
      },
    }),
  ],
  [
    'a gallery item',
    (member) => ({
      embed: {
        $type: 'app.bsky.embed.recordWithMedia',
        record: embeddedRecord('eva-op'),
        media: { $type: 'app.bsky.embed.gallery', items: [member] },
      },
    }),
  ],
]

function defineMalformedUnionRefusals(getHarness: () => WriteHarness) {
  describe('a union member with a malformed $type', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
      await seedPost(harness, 'eva-op')
    })

    async function snapshot() {
      return {
        rows: await harness.recordRows(uriOf('eva00')),
        root: await harness.repoRoot(PILOT),
        ops: await harness.sequencedOps(PILOT),
      }
    }

    describe.each(PROCEDURES)('on $name', (procedure) => {
      describe.each(MALFORMED_TYPES)('with the type %s', (malformed) => {
        it.each([
          ['absent', {}],
          ['true', { validate: true }],
        ])(
          'is refused as InvalidRecord with validate %s',
          async (_mode, fields) => {
            const before = await snapshot()

            const response = await procedure.send(
              harness,
              post('Sortie', { embed: { $type: malformed } }),
              fields,
            )

            expect(response.status).toBe(400)
            expect(response.body).toMatchObject({
              error: 'InvalidRecord',
              message: expect.stringContaining(COLLECTION),
            })
            expect(await snapshot()).toEqual(before)
          },
        )
      })
    })

    describe.each(UNION_SLOTS)('in %s', (_slot, place) => {
      it.each(MALFORMED_TYPES)(
        'refuses the type %s as InvalidRecord',
        async (malformed) => {
          const before = await snapshot()

          const response = await PROCEDURES[0].send(
            harness,
            post('Sortie', place({ $type: malformed })),
            {},
          )

          expect(response.status).toBe(400)
          expect(response.body).toMatchObject({
            error: 'InvalidRecord',
            message: expect.stringContaining(COLLECTION),
          })
          expect(await snapshot()).toEqual(before)
        },
      )
    })

    describe.each(PROCEDURES)('on $name with validate false', (procedure) => {
      it.each(MALFORMED_TYPES)(
        'accepts the type %s because no lexicon check runs',
        async (malformed) => {
          const response = await procedure.send(
            harness,
            post('Sortie', { embed: { $type: malformed } }),
            { validate: false },
          )

          expect(response.status).toBe(200)
          expect(procedure.statusOf(response.body)).toBeUndefined()
        },
      )
    })
  })
}

function defineUnstorableValues(getHarness: () => WriteHarness) {
  describe('a value the data model cannot store', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
    })

    describe.each(PROCEDURES)('on $name', (procedure) => {
      it.each([
        ['absent', {}],
        ['false', { validate: false }],
      ])(
        'is refused as InvalidRecord with validate %s and nothing is stored',
        async (_mode, fields) => {
          const before = await harness.repoRoot(PILOT)

          const response = await procedure.send(
            harness,
            post('Sortie', { sync: 0.5 }),
            fields,
          )

          expect(response.status).toBe(400)
          expect(response.body).toMatchObject({
            error: 'InvalidRecord',
            message: expect.stringContaining(COLLECTION),
          })
          expect(await harness.repoRoot(PILOT)).toEqual(before)
        },
      )
    })
  })
}

function defineUnreadableReferences(getHarness: () => WriteHarness) {
  describe('a reference uri that is not a string with validate false', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await enrollPilot(harness)
      await seedPost(harness, 'eva-op')
    })

    const CASES: Array<[string, Record<string, unknown>]> = [
      [
        'reply.parent.uri',
        {
          reply: {
            root: strongRef('eva-op'),
            parent: { uri: 5, cid: POST_CID },
          },
        },
      ],
      [
        'reply.root.uri',
        {
          reply: {
            root: { uri: { at: 'eva-op' }, cid: POST_CID },
            parent: strongRef('eva-op'),
          },
        },
      ],
      [
        'an embedded record uri',
        { embed: { $type: 'app.bsky.embed.record', record: { uri: 7 } } },
      ],
      [
        'the embedded record uri of a recordWithMedia media',
        {
          embed: {
            $type: 'app.bsky.embed.recordWithMedia',
            media: { record: { uri: ['eva-op'] } },
          },
        },
      ],
    ]

    describe.each(PROCEDURES)('on $name', (procedure) => {
      it.each(CASES)('refuses %s as InvalidRecord', async (_name, extra) => {
        const before = await harness.repoRoot(PILOT)

        const response = await procedure.send(harness, post('Roger', extra), {
          validate: false,
        })

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({
          error: 'InvalidRecord',
          message: expect.stringContaining(COLLECTION),
        })
        expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
        expect(await harness.repoRoot(PILOT)).toEqual(before)
      })
    })
  })
}

function defineRulesWithValidateFalse(getHarness: () => WriteHarness) {
  describe('Stratos rules with validate false', () => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
      await seedPost(harness, 'eva-op')
    })

    const escapingReply = () =>
      post('Roger', {
        reply: { root: strongRef('eva-op'), parent: strongRef('eva-op') },
      })

    it.each([
      [
        'createRecord',
        CREATE,
        (record: unknown) => ({
          collection: COLLECTION,
          rkey: 'eva-re',
          record,
        }),
      ],
      [
        'applyWrites',
        APPLY_WRITES,
        (record: unknown) => ({
          writes: [{ ...writeEntry(record), rkey: 'eva-re' }],
        }),
      ],
    ])(
      'still refuses a reply that escapes its parent on %s',
      async (_name, nsid, fields) => {
        const before = await harness.repoRoot(PILOT)

        const response = await harness.call(nsid, asMember(PILOT), {
          boundary: HARNESS_DESIGN,
          repo: PILOT,
          validate: false,
          ...fields(escapingReply()),
        })

        expect(response.status).toBe(400)
        expect(response.body).toMatchObject({
          error: 'InvalidRecord',
          message: expect.stringContaining('Reply boundaries must be a subset'),
        })
        expect(await harness.repoRoot(PILOT)).toEqual(before)
      },
    )
  })
}

const arbitraryJson: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.string(),
  fc.stringMatching(/^[#a-zA-Z.]{0,16}$/),
  fc.constantFrom('', '#', '##', 'a#', '#a#', 'a#b#c', '#x'),
  fc.string({ minLength: 2000, maxLength: 4000 }),
  fc.integer(),
  fc.double(),
  fc.constant(null),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 })),
)

/** Every path to a value inside the record, the record itself excluded. */
function nestedPaths(
  value: unknown,
  prefix: Array<string | number> = [],
): Array<Array<string | number>> {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, Array.isArray(value) ? Number(key) : key]
    return [path, ...nestedPaths(child, path)]
  })
}

function replaceAt(
  record: Record<string, unknown>,
  path: Array<string | number>,
  replacement: unknown,
): Record<string, unknown> {
  const copy = structuredClone(record)
  let node = copy as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>
  }
  node[path[path.length - 1]] = replacement
  return copy
}

function defineNeverServerError(getHarness: () => WriteHarness) {
  describe('a malformed record never answers 5xx', () => {
    let harness: WriteHarness
    let counter = 0

    beforeEach(async () => {
      harness = getHarness()
      counter = 0
      enrolledWriters.clear()
      await enrollPilot(harness)
      await seedPost(harness, 'eva-op')
    })

    // The write limit counts every attempt, so the requests are spread over
    // members to keep a rate limit from standing in for the answer under test.
    const REQUESTS_PER_MEMBER = 200
    const enrolledWriters = new Set<string>()

    async function writerFor(request: number) {
      const writer = `did:plc:pilot-${Math.floor(request / REQUESTS_PER_MEMBER)}`
      if (!enrolledWriters.has(writer)) {
        await harness.enrollMember(writer, [HARNESS_ENGINEERING])
        enrolledWriters.add(writer)
      }
      return writer
    }

    async function sendCreate(record: unknown, fields: ValidateField) {
      const request = counter++
      const writer = await writerFor(request)
      return harness.call(CREATE, asMember(writer), {
        boundary: HARNESS_ENGINEERING,
        repo: writer,
        collection: COLLECTION,
        rkey: `eva-p${request}`,
        record,
        ...fields,
      })
    }

    it('for any value as the $type of a union member', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.nat(UNION_SLOTS.length - 1),
          arbitraryJson,
          fc.constantFrom<ValidateField>(
            {},
            { validate: true },
            { validate: false },
          ),
          async (slot, member, fields) => {
            const record = post(
              'Sortie',
              UNION_SLOTS[slot][1]({ $type: member }),
            )

            const response = await sendCreate(record, fields)

            expect(response.status).toBeLessThan(500)
            expect(response.status).not.toBe(429)
          },
        ),
        { numRuns: 150 },
      )
    })

    const richPost = () =>
      post('Sortie', {
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: [{ value: HARNESS_ENGINEERING }],
        },
        facets: [
          {
            index: { byteStart: 0, byteEnd: 3 },
            features: [
              { $type: 'app.bsky.richtext.facet#mention', did: MENTOR },
            ],
          },
        ],
        reply: { root: strongRef('eva-op'), parent: strongRef('eva-op') },
        labels: {
          $type: 'com.atproto.label.defs#selfLabels',
          values: [{ val: 'graphic-media' }],
        },
        embed: {
          $type: 'app.bsky.embed.recordWithMedia',
          record: embeddedRecord('eva-op'),
          media: embeddedImages,
        },
        langs: ['ja'],
        tags: ['eva'],
      })

    it('accepts the valid post the replacements start from', async () => {
      const response = await sendCreate(richPost(), {})

      expect(response.status).toBe(200)
    })

    it('for any nested value of a valid post replaced by any json value', async () => {
      const paths = nestedPaths(richPost())
      await fc.assert(
        fc.asyncProperty(
          fc.nat(paths.length - 1),
          arbitraryJson,
          fc.constantFrom<ValidateField>(
            {},
            { validate: true },
            { validate: false },
          ),
          async (pathIndex, replacement, fields) => {
            const record = replaceAt(richPost(), paths[pathIndex], replacement)

            const response = await sendCreate(record, fields)

            expect(response.status).toBeLessThan(500)
            expect(response.status).not.toBe(429)
          },
        ),
        { numRuns: 300 },
      )
    })
  })
}

const INTERACTION_COLLECTIONS = ['app.bsky.feed.like', 'app.bsky.feed.repost']
const PDS_MEMBER = 'did:plc:asuka-langley'
const SERVICE_OF_BOUNDARY = HARNESS_ENGINEERING.split('/')[0]
const SPACE_FORM_URI = `at://${SERVICE_OF_BOUNDARY}/space/zone.stratos.space.feed/engineering/${PDS_MEMBER}/${COLLECTION}/eva02`

function interactionRecord(
  collection: string,
  subject: unknown,
  via: unknown,
  createdAt: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    $type: collection,
    subject,
    createdAt,
    ...(via === undefined ? {} : { via }),
  }
}

const interactionStrongRef = fc.record({
  uri: fc.oneof(
    fc.constantFrom(uriOf('eva-op'), SPACE_FORM_URI, `${uriOf('eva-op')}/`),
    arbitraryJson,
  ),
  cid: fc.oneof(fc.constant(POST_CID), arbitraryJson),
})

const interactionSubject = fc.oneof(interactionStrongRef, arbitraryJson)

// Values that no lex-form decoder rewrites, so the service sees what was sent.
const plainNonString = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 3 }),
  fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.integer(), {
    maxKeys: 3,
  }),
)
const wellFormedSubjectUri = fc.constantFrom(uriOf('eva-op'), SPACE_FORM_URI)
// A leading space keeps the string from being an at-uri or a cid.
const notAUriOrCid = fc.string().map((tail) => ` ${tail}`)

const misshapenSubject = fc.oneof(
  plainNonString,
  fc.string(),
  fc.record({ cid: fc.constant(POST_CID) }),
  fc.record({ uri: plainNonString, cid: fc.constant(POST_CID) }),
  fc.record({ uri: notAUriOrCid, cid: fc.constant(POST_CID) }),
  fc.record({ uri: wellFormedSubjectUri }),
  fc.record({ uri: wellFormedSubjectUri, cid: plainNonString }),
  fc.record({ uri: wellFormedSubjectUri, cid: notAUriOrCid }),
)

const interactionVia = fc.option(
  fc.oneof(interactionStrongRef, arbitraryJson),
  { nil: undefined },
)

const MISSING_STORE_URI = `at://did:plc:gendo-ikari/${COLLECTION}/eva00`

const replyAuthorUri = fc.oneof(
  fc.constantFrom(
    uriOf('eva-op'),
    MISSING_STORE_URI,
    SPACE_FORM_URI,
    'at://not-a-did/zone.stratos.feed.post/eva00',
    'not a uri',
    '',
  ),
  arbitraryJson,
)

const replyStrongRef = fc.record({
  uri: replyAuthorUri,
  cid: fc.oneof(fc.constant(POST_CID), arbitraryJson),
})

const replyOf = fc.oneof(
  fc.record({ root: replyStrongRef, parent: replyStrongRef }),
  fc.record({ parent: replyStrongRef }),
  arbitraryJson,
)

// Fields a like or repost does not declare. A reply naming a parent no actor
// store backs must be answered like any other extra field.
const interactionExtras = fc
  .tuple(
    fc.dictionary(
      fc.oneof(fc.constantFrom('embed', 'langs', 'text'), fc.string()),
      arbitraryJson,
      { maxKeys: 3 },
    ),
    fc.option(replyOf, { nil: undefined }),
  )
  .map(([fields, reply]) =>
    reply === undefined ? fields : { ...fields, reply },
  )

const interactionCreatedAt = fc.oneof(
  fc.constant('1996-10-04T00:00:00.000Z'),
  arbitraryJson,
)

function defineInteractionNeverServerError(getHarness: () => WriteHarness) {
  describe('a like or repost never answers 5xx', () => {
    let harness: WriteHarness
    let counter = 0
    const enrolledWriters = new Set<string>()
    const REQUESTS_PER_MEMBER = 100

    beforeEach(async () => {
      harness = getHarness()
      counter = 0
      enrolledWriters.clear()
      await enrollPilot(harness)
      await harness.enrollPdsCustodyMember(PDS_MEMBER, [HARNESS_ENGINEERING])
      await seedPost(harness, 'eva-op')
    })

    // The write limit counts every attempt, so the requests are spread over
    // members to keep a rate limit from standing in for the answer under test.
    async function nextWriter() {
      const request = counter++
      const writer = `did:plc:pilot-${Math.floor(request / REQUESTS_PER_MEMBER)}`
      if (!enrolledWriters.has(writer)) {
        await harness.enrollMember(writer, [HARNESS_ENGINEERING])
        enrolledWriters.add(writer)
      }
      return { writer, rkey: `eva-i${request}` }
    }

    const SENDERS: Array<{
      name: string
      send(
        collection: string,
        record: unknown,
        fields: ValidateField,
      ): Promise<CallResult>
    }> = [
      {
        name: 'createRecord',
        send: async (collection, record, fields) => {
          const { writer, rkey } = await nextWriter()
          return harness.call(CREATE, asMember(writer), {
            boundary: HARNESS_ENGINEERING,
            repo: writer,
            collection,
            rkey,
            record,
            ...fields,
          })
        },
      },
      {
        name: 'putRecord',
        send: async (collection, record, fields) => {
          const { writer, rkey } = await nextWriter()
          return harness.call(PUT, asMember(writer), {
            boundary: HARNESS_ENGINEERING,
            repo: writer,
            collection,
            rkey,
            record,
            ...fields,
          })
        },
      },
      {
        name: 'applyWrites create',
        send: async (collection, record, fields) => {
          const { writer, rkey } = await nextWriter()
          return harness.call(APPLY_WRITES, asMember(writer), {
            boundary: HARNESS_ENGINEERING,
            repo: writer,
            writes: [
              {
                $type: `${WRITE_TYPE}create`,
                collection,
                rkey,
                value: record,
              },
            ],
            ...fields,
          })
        },
      },
      {
        name: 'applyWrites update',
        send: async (collection, record, fields) => {
          const { writer, rkey } = await nextWriter()
          await harness.call(CREATE, asMember(writer), {
            boundary: HARNESS_ENGINEERING,
            repo: writer,
            collection,
            rkey,
            record: interactionRecord(
              collection,
              strongRef('eva-op'),
              undefined,
              '1996-10-04T00:00:00.000Z',
            ),
            validate: false,
          })
          return harness.call(APPLY_WRITES, asMember(writer), {
            boundary: HARNESS_ENGINEERING,
            repo: writer,
            writes: [
              {
                $type: `${WRITE_TYPE}update`,
                collection,
                rkey,
                value: record,
              },
            ],
            ...fields,
          })
        },
      },
    ]

    it.each(SENDERS)(
      'through $name for any subject, via, createdAt and extra fields',
      async (sender) => {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom(...INTERACTION_COLLECTIONS),
            interactionSubject,
            interactionVia,
            interactionCreatedAt,
            interactionExtras,
            fc.constantFrom<ValidateField>(
              {},
              { validate: true },
              { validate: false },
            ),
            async (collection, subject, via, createdAt, extra, fields) => {
              const record = interactionRecord(
                collection,
                subject,
                via,
                createdAt,
                extra,
              )

              const response = await sender.send(collection, record, fields)

              expect(response.status).toBeLessThan(500)
              expect(response.status).not.toBe(429)
            },
          ),
          { numRuns: 60 },
        )
      },
    )

    it.each(SENDERS)(
      'through $name answers the subject error for any subject that is not a strong reference',
      async (sender) => {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom(...INTERACTION_COLLECTIONS),
            misshapenSubject,
            fc.constantFrom<ValidateField>(
              {},
              { validate: true },
              { validate: false },
            ),
            async (collection, subject, fields) => {
              const record = interactionRecord(
                collection,
                subject,
                undefined,
                '1996-10-04T00:00:00.000Z',
              )

              const response = await sender.send(collection, record, fields)

              expect(response).toEqual({
                status: 400,
                body: {
                  error: 'InvalidRecord',
                  message: 'The subject must be a post in this boundary',
                },
              })
            },
          ),
          { numRuns: 60 },
        )
      },
    )

    it('through deleteRecord for any rkey', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...INTERACTION_COLLECTIONS),
          arbitraryJson,
          async (collection, rkey) => {
            const { writer } = await nextWriter()

            const response = await harness.call(
              'zone.stratos.repo.deleteRecord',
              asMember(writer),
              {
                boundary: HARNESS_ENGINEERING,
                repo: writer,
                collection,
                rkey,
              },
            )

            expect(response.status).toBeLessThan(500)
            expect(response.status).not.toBe(429)
          },
        ),
        { numRuns: 60 },
      )
    })
  })
}

describe('lexicon strategies on an unlisted collection', () => {
  const record = { $type: UNLISTED_COLLECTION, text: 'Sortie' }

  it('accepts it as unknown when validation is not required', () => {
    expect(validateIfKnown(UNLISTED_COLLECTION, record)).toBe('unknown')
  })

  it('refuses it by name when validation is required', () => {
    expect(() => requireLexiconValidation(UNLISTED_COLLECTION, record)).toThrow(
      new InvalidRequestError(
        `Unknown lexicon type: ${UNLISTED_COLLECTION}`,
        'InvalidRecord',
      ),
    )
  })

  it('reports no status when validation is skipped', () => {
    expect(skipLexiconValidation()).toBeUndefined()
  })

  it('treats a collection that is not a record lexicon as unknown', () => {
    expect(validateIfKnown('com.atproto.repo.createRecord', record)).toBe(
      'unknown',
    )
  })
})

describe('lexicon strategies on a stratos post', () => {
  const asciiText = (minLength: number, maxLength: number) =>
    fc.string({
      unit: fc.constantFrom('a', 'b', ' ', '.'),
      minLength,
      maxLength,
    })

  it('names the collection in every refusal of a post over the limit', () => {
    fc.assert(
      fc.property(asciiText(3001, 3300), (text) => {
        for (const strategy of [validateIfKnown, requireLexiconValidation]) {
          expect(() => strategy(COLLECTION, post(text))).toThrow(
            expect.objectContaining({
              customErrorName: 'InvalidRecord',
              message: expect.stringContaining(COLLECTION),
            }),
          )
        }
      }),
      { numRuns: 50 },
    )
  })

  it('reports valid for a post within the limits whichever strategy asks', () => {
    fc.assert(
      fc.property(asciiText(0, 300), (text) => {
        expect(validateIfKnown(COLLECTION, post(text))).toBe('valid')
        expect(requireLexiconValidation(COLLECTION, post(text))).toBe('valid')
      }),
      { numRuns: 50 },
    )
  })

  it('judges an untyped boundary claim as a domains claim without storing a type', () => {
    const untyped: Record<string, unknown> = post('Sortie', {
      boundary: { values: [{ value: HARNESS_ENGINEERING }] },
    })

    expect(validateIfKnown(COLLECTION, untyped)).toBe('valid')
    expect(untyped.boundary).toEqual({
      values: [{ value: HARNESS_ENGINEERING }],
    })
  })
})

describe('boundary record validation on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineValidateMatrix(() => harness)
  defineTypeRefusals(() => harness)
  defineEmbedCases(() => harness)
  defineApplyWritesStatuses(() => harness)
  defineBodyLimits(() => harness)
  defineLegacyLeniency(() => harness)
  defineDirectCalls(() => harness)
  defineMalformedUnionRefusals(() => harness)
  defineUnstorableValues(() => harness)
  defineUnreadableReferences(() => harness)
  defineRulesWithValidateFalse(() => harness)
  defineNeverServerError(() => harness)
  defineInteractionNeverServerError(() => harness)
})

describe('boundary record validation on postgres', () => {
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
    await enrollPilot(harness)
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  describe.each(PROCEDURES)('$name', (procedure) => {
    it('reports valid for a valid post', async () => {
      const response = await procedure.send(harness, post('Sortie'), {})

      expect(response.status).toBe(200)
      expect(procedure.statusOf(response.body)).toBe('valid')
    })

    it('refuses a post over the text limit and stores nothing', async () => {
      const response = await procedure.send(harness, post(OVER_TEXT_LIMIT), {})

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'InvalidRecord',
        message: expect.stringContaining(COLLECTION),
      })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })

    it('refuses a union member with a malformed type as InvalidRecord', async () => {
      const response = await procedure.send(
        harness,
        post('Sortie', { embed: { $type: 'a#b#c' } }),
        {},
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        error: 'InvalidRecord',
        message: expect.stringContaining(COLLECTION),
      })
      expect((await harness.recordRows(uriOf('eva00'))).record).toBeNull()
    })
  })
})
