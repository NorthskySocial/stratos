import { readFileSync } from 'node:fs'
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
import { InvalidRequestError } from '@atproto/xrpc-server'
import { formatRecordUri } from '@northskysocial/stratos-core'
import { applyWritesBatch, updateRecord } from '../src/api/records/index.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type CallResult,
  type WriteHarness,
} from './helpers/write-harness.js'
import { startLabelRoute, type LabelRoute } from './helpers/label-route.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const POST = 'zone.stratos.feed.post'
const INTERACTIONS = [LIKE, REPOST]
const SUBJECT_ERROR = 'The subject must be a post in this boundary'
const SUBJECT_BODY = { error: 'InvalidRecord', message: SUBJECT_ERROR }
const PREFIX_ERROR = 'Only zone.stratos.* collections are supported'
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const ASUKA = 'did:plc:asuka-langley'
const REI = 'did:plc:rei-ayanami'
const KAWORU = 'did:plc:kaworu-nagisa'
const MAKOTO = 'did:plc:makoto-hyuga'
const STALE_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CREATE = 'zone.stratos.repo.createRecord'
const PUT = 'zone.stratos.repo.putRecord'
const APPLY_WRITES = 'zone.stratos.repo.applyWrites'
const WRITE_TYPE = `${APPLY_WRITES}#`
const LEGACY_CREATE = 'com.atproto.repo.createRecord'
const LEGACY_DELETE = 'com.atproto.repo.deleteRecord'
const LEGACY_APPLY_WRITES = 'com.atproto.repo.applyWrites'
const DECLARATION_PATH = new URL(
  '../../lexicons-spaces/zone/stratos/space/feed.json',
  import.meta.url,
)

type ValidateField = { validate?: boolean }

const VALIDATE_MODES: ValidateField[] = [
  { validate: false },
  {},
  { validate: true },
]

const repoUriOf = (author: string, rkey: string) =>
  `at://${author}/${POST}/${rkey}`

function spaceUriOf(
  author: string,
  rkey: string,
  overrides: {
    authority?: string
    spaceType?: string
    skey?: string
    collection?: string
  } = {},
): string {
  const formatted = formatRecordUri({
    spaceDid: overrides.authority ?? HARNESS_SERVICE_DID,
    spaceType: overrides.spaceType ?? HOSTED_SPACE_TYPE,
    skey: overrides.skey ?? 'engineering',
    authorDid: author,
    collection: overrides.collection ?? POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

const interaction = (
  collection: string,
  subject: unknown,
  extra: Record<string, unknown> = {},
) => ({
  $type: collection,
  subject,
  createdAt: '1996-10-04T00:00:00.000Z',
  ...extra,
})

async function seedPost(
  harness: WriteHarness,
  author: string,
  rkey: string,
  boundary = HARNESS_ENGINEERING,
): Promise<string> {
  const created = await harness.call(CREATE, asMember(author), {
    boundary,
    repo: author,
    collection: POST,
    rkey,
    record: {
      $type: POST,
      text: `sortie ${rkey}`,
      createdAt: '1996-10-04T00:00:00.000Z',
    },
  })
  expect(created.status).toBe(200)
  return (created.body as { cid: string }).cid
}

interface SendContext {
  harness: WriteHarness
  did: string
  boundary: string
  /** A record the member may already hold at the rkey, for the update. */
  baseline: unknown
}

interface InteractionProcedure {
  name: string
  send(
    context: SendContext,
    collection: string,
    rkey: string,
    record: unknown,
    fields: ValidateField,
  ): Promise<CallResult>
  statusOf(body: unknown): unknown
}

const createFor = (
  context: SendContext,
  collection: string,
  rkey: string,
  record: unknown,
) =>
  context.harness.call(CREATE, asMember(context.did), {
    boundary: context.boundary,
    repo: context.did,
    collection,
    rkey,
    record,
    validate: false,
  })

const INTERACTION_PROCEDURES: InteractionProcedure[] = [
  {
    name: 'createRecord',
    send: (context, collection, rkey, record, fields) =>
      context.harness.call(CREATE, asMember(context.did), {
        boundary: context.boundary,
        repo: context.did,
        collection,
        rkey,
        record,
        ...fields,
      }),
    statusOf: (body) =>
      (body as { validationStatus?: unknown }).validationStatus,
  },
  {
    name: 'putRecord',
    send: (context, collection, rkey, record, fields) =>
      context.harness.call(PUT, asMember(context.did), {
        boundary: context.boundary,
        repo: context.did,
        collection,
        rkey,
        record,
        ...fields,
      }),
    statusOf: (body) =>
      (body as { validationStatus?: unknown }).validationStatus,
  },
  {
    name: 'applyWrites #create',
    send: (context, collection, rkey, record, fields) =>
      context.harness.call(APPLY_WRITES, asMember(context.did), {
        boundary: context.boundary,
        repo: context.did,
        writes: [
          { $type: `${WRITE_TYPE}create`, collection, rkey, value: record },
        ],
        ...fields,
      }),
    statusOf: (body) =>
      (body as { results: Array<{ validationStatus?: unknown }> }).results[0]
        .validationStatus,
  },
  {
    name: 'applyWrites #update',
    send: async (context, collection, rkey, record, fields) => {
      const seeded = await createFor(
        context,
        collection,
        rkey,
        context.baseline,
      )
      expect(seeded.status).toBe(200)
      return context.harness.call(APPLY_WRITES, asMember(context.did), {
        boundary: context.boundary,
        repo: context.did,
        writes: [
          { $type: `${WRITE_TYPE}update`, collection, rkey, value: record },
        ],
        ...fields,
      })
    },
    statusOf: (body) =>
      (body as { results: Array<{ validationStatus?: unknown }> }).results[0]
        .validationStatus,
  },
]

/**
 * Holds the member drain of the next deactivation open, so the boundary is
 * `deactivating` in the catalog while the write cache still lists it.
 */
function holdNextDrain(harness: WriteHarness) {
  const { ctx } = harness
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const removeBoundary = ctx.enrollmentStore.removeBoundary.bind(
    ctx.enrollmentStore,
  )
  const spy = vi
    .spyOn(ctx.enrollmentStore, 'removeBoundary')
    .mockImplementationOnce(async (did, boundary) => {
      await held
      await removeBoundary(did, boundary)
    })
  const started: Promise<unknown>[] = []
  return {
    release,
    async deactivate(boundary: string) {
      const definition = await harness.ctx.boundaryStore!.get(boundary)
      const finished = ctx.boundaryManager!.deactivate(
        boundary,
        definition!.revision,
      )
      started.push(finished)
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    },
    async settle() {
      release()
      await Promise.all(started)
    },
  }
}

async function reactivateDesign(harness: WriteHarness) {
  const definition = await harness.ctx.boundaryStore!.get(HARNESS_DESIGN)
  if (definition && definition.status !== 'active') {
    await harness.ctx.boundaryManager!.reactivate(
      HARNESS_DESIGN,
      definition.revision,
    )
  }
}

function defineAcceptedInteractions(getHarness: () => WriteHarness) {
  describe.each(INTERACTIONS)('a %s of a visible post', (collection) => {
    let harness: WriteHarness
    let cid: string

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      cid = await seedPost(harness, SHINJI, 'eva01')
    })

    describe.each(INTERACTION_PROCEDURES)('through $name', (procedure) => {
      const context = (): SendContext => ({
        harness,
        did: MISATO,
        boundary: HARNESS_ENGINEERING,
        baseline: interaction(collection, {
          uri: repoUriOf(SHINJI, 'eva01'),
          cid,
        }),
      })

      it('is accepted without a zone.stratos prefix and reports valid', async () => {
        const record = interaction(collection, {
          uri: repoUriOf(SHINJI, 'eva01'),
          cid,
        })

        const response = await procedure.send(
          context(),
          collection,
          'eva-like',
          record,
          {},
        )

        expect(response.status).toBe(200)
        expect(procedure.statusOf(response.body)).toBe('valid')
        const rows = await harness.recordRows(
          `at://${MISATO}/${collection}/eva-like`,
        )
        expect(rows.boundaries).toEqual([HARNESS_ENGINEERING])
        expect(rows.record?.value).toMatchObject(record)
      })

      it('is accepted with validate false and reports no status', async () => {
        const record = interaction(collection, {
          uri: repoUriOf(SHINJI, 'eva01'),
          cid,
        })

        const response = await procedure.send(
          context(),
          collection,
          'eva-like',
          record,
          { validate: false },
        )

        expect(response.status).toBe(200)
        expect(procedure.statusOf(response.body)).toBeUndefined()
      })
    })
  })
}

function defineSubjectRefusals(getHarness: () => WriteHarness) {
  describe.each(INTERACTIONS)(
    'a %s of a subject that is wrong',
    (collection) => {
      let harness: WriteHarness
      let labels: LabelRoute
      let cid: string
      let heldAuthorSubject: unknown
      let unenrolledAuthorSubject: unknown

      beforeEach(async () => {
        harness = getHarness()
        await harness.enrollMember(SHINJI, [
          HARNESS_ENGINEERING,
          HARNESS_DESIGN,
        ])
        await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
        await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
        await harness.enrollPdsCustodyMember(REI, [HARNESS_DESIGN])
        cid = await seedPost(harness, SHINJI, 'eva01')
        await seedPost(harness, SHINJI, 'eva03')
        labels = await startLabelRoute(harness)
        expect(await labels.takeDownRecord(repoUriOf(SHINJI, 'eva03'))).toBe(
          200,
        )
        await seedPost(harness, SHINJI, 'eva04', HARNESS_DESIGN)

        await harness.enrollMember(KAWORU, [HARNESS_ENGINEERING])
        const heldCid = await seedPost(harness, KAWORU, 'eva05')
        heldAuthorSubject = { uri: repoUriOf(KAWORU, 'eva05'), cid: heldCid }
        await harness.holdMember(KAWORU)

        await harness.enrollMember(MAKOTO, [HARNESS_ENGINEERING])
        const leaverCid = await seedPost(harness, MAKOTO, 'eva06')
        await harness.ctx.enrollmentStore.unenroll(MAKOTO)
        unenrolledAuthorSubject = {
          uri: repoUriOf(MAKOTO, 'eva06'),
          cid: leaverCid,
        }
      })

      afterEach(async () => {
        await labels.close()
      })

      const refusedSubjects = (): Array<[string, unknown]> => [
        [
          'a handle authority',
          { uri: `at://shinji.nerv.tokyo.jp/${POST}/eva01`, cid },
        ],
        [
          'a uri that is not canonical',
          { uri: `${repoUriOf(SHINJI, 'eva01')}#/text`, cid },
        ],
        [
          'an actor store that does not exist',
          { uri: repoUriOf('did:plc:gendo-ikari', 'eva13'), cid },
        ],
        [
          'a record that does not exist',
          { uri: repoUriOf(SHINJI, 'eva99'), cid },
        ],
        [
          'a record in another boundary',
          { uri: repoUriOf(SHINJI, 'eva04'), cid },
        ],
        [
          'a record that was taken down',
          { uri: repoUriOf(SHINJI, 'eva03'), cid },
        ],
        ['a held author', heldAuthorSubject],
        ['an author who is no longer enrolled', unenrolledAuthorSubject],
        [
          'a cid that is not the stored one',
          { uri: repoUriOf(SHINJI, 'eva01'), cid: STALE_CID },
        ],
        [
          'a space of another service',
          {
            uri: spaceUriOf(ASUKA, 'eva02', {
              authority: 'did:web:seele.example',
            }),
            cid: STALE_CID,
          },
        ],
        [
          'a space of another type',
          {
            uri: spaceUriOf(ASUKA, 'eva02', {
              spaceType: 'zone.stratos.space.eva',
            }),
            cid: STALE_CID,
          },
        ],
        [
          'a space of another boundary',
          {
            uri: spaceUriOf(ASUKA, 'eva02', { skey: 'design' }),
            cid: STALE_CID,
          },
        ],
        [
          'a pds-custody author who is not a member of the boundary',
          { uri: spaceUriOf(REI, 'eva00'), cid: STALE_CID },
        ],
        [
          'a stratos-custody author in space form',
          { uri: spaceUriOf(SHINJI, 'eva01'), cid: STALE_CID },
        ],
        [
          'a space-form author with no enrollment',
          { uri: spaceUriOf('did:plc:gendo-ikari', 'eva13'), cid: STALE_CID },
        ],
        [
          'a collection that is not a post',
          {
            uri: spaceUriOf(ASUKA, 'eva02', { collection: LIKE }),
            cid: STALE_CID,
          },
        ],
      ]

      const send = (
        procedure: InteractionProcedure,
        subject: unknown,
        rkey: string,
        fields: ValidateField,
      ) =>
        procedure.send(
          {
            harness,
            did: MISATO,
            boundary: HARNESS_ENGINEERING,
            // One interaction per subject, so each baseline names its own.
            baseline: interaction(collection, {
              uri: spaceUriOf(ASUKA, rkey),
              cid,
            }),
          },
          collection,
          rkey,
          interaction(collection, subject),
          fields,
        )

      it('answers one status and one body whatever is wrong, under every validate value', async () => {
        const bodies = new Set<string>()
        let counter = 0
        for (const [name, subject] of refusedSubjects()) {
          for (const fields of VALIDATE_MODES) {
            const response = await send(
              INTERACTION_PROCEDURES[0],
              subject,
              `eva-c${counter++}`,
              fields,
            )

            expect(response.status, name).toBe(400)
            expect(response.body, name).toEqual(SUBJECT_BODY)
            bodies.add(JSON.stringify(response))
          }
        }
        expect(bodies.size).toBe(1)
      })

      it.each(INTERACTION_PROCEDURES.slice(1))(
        'answers the same body through $name',
        async (procedure) => {
          const samples = refusedSubjects().filter(
            (_, index) => index % 3 === 0,
          )
          let counter = 0
          for (const [name, subject] of samples) {
            const response = await send(
              procedure,
              subject,
              `eva-p${counter++}`,
              {},
            )

            expect(response.status, name).toBe(400)
            expect(response.body, name).toEqual(SUBJECT_BODY)
          }
        },
      )

      it('stores nothing and sequences nothing for a refused like', async () => {
        const root = await harness.repoRoot(MISATO)
        const ops = await harness.sequencedOps(MISATO)

        const response = await send(
          INTERACTION_PROCEDURES[0],
          { uri: repoUriOf(SHINJI, 'eva99'), cid },
          'eva-none',
          {},
        )

        expect(response.status).toBe(400)
        expect(
          (await harness.recordRows(`at://${MISATO}/${collection}/eva-none`))
            .record,
        ).toBeNull()
        expect(await harness.repoRoot(MISATO)).toEqual(root)
        expect(await harness.sequencedOps(MISATO)).toEqual(ops)
      })

      it('judges a subject the lexicon cannot read by the lexicon when it checks, and by the rule when it does not', async () => {
        const unreadable = [
          { uri: 7, cid },
          { uri: repoUriOf(SHINJI, 'eva01'), cid: 7 },
          'eva01',
        ]
        for (const subject of unreadable) {
          const skipped = await send(
            INTERACTION_PROCEDURES[0],
            subject,
            'eva-skip',
            { validate: false },
          )
          const checked = await send(
            INTERACTION_PROCEDURES[0],
            subject,
            'eva-check',
            {},
          )

          expect(skipped.status).toBe(400)
          expect(skipped.body).toEqual(SUBJECT_BODY)
          expect(checked.status).toBe(400)
          expect(checked.body).toMatchObject({ error: 'InvalidRecord' })
        }
      })

      it('gives a stale cid the subject error and the current one acceptance', async () => {
        const stale = await send(
          INTERACTION_PROCEDURES[0],
          { uri: repoUriOf(SHINJI, 'eva01'), cid: STALE_CID },
          'eva-stale',
          {},
        )
        const current = await send(
          INTERACTION_PROCEDURES[0],
          { uri: repoUriOf(SHINJI, 'eva01'), cid },
          'eva-current',
          {},
        )

        expect(stale.body).toEqual(SUBJECT_BODY)
        expect(current.status).toBe(200)
      })
    },
  )
}

function defineSpaceFormInteractions(getHarness: () => WriteHarness) {
  describe.each(INTERACTIONS)('a %s of a pds-custody post', (collection) => {
    let harness: WriteHarness

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
    })

    it.each(INTERACTION_PROCEDURES)(
      'is accepted in space form through $name and stored as sent',
      async (procedure) => {
        const subject = {
          uri: spaceUriOf(ASUKA, 'eva02'),
          cid: STALE_CID,
        }

        const response = await procedure.send(
          {
            harness,
            did: MISATO,
            boundary: HARNESS_ENGINEERING,
            baseline: interaction(collection, subject),
          },
          collection,
          'eva-space',
          interaction(collection, subject),
          {},
        )

        expect(response.status).toBe(200)
        expect(procedure.statusOf(response.body)).toBe('valid')
        const rows = await harness.recordRows(
          `at://${MISATO}/${collection}/eva-space`,
        )
        expect(rows.record?.value).toMatchObject({ subject })
      },
    )

    it('is refused once the pds-custody author is held', async () => {
      await harness.holdMember(ASUKA)

      const response = await harness.call(CREATE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection,
        rkey: 'eva-held',
        record: interaction(collection, {
          uri: spaceUriOf(ASUKA, 'eva02'),
          cid: STALE_CID,
        }),
      })

      expect(response.status).toBe(400)
      expect(response.body).toEqual(SUBJECT_BODY)
    })
  })
}

function defineCatalogWindow(getHarness: () => WriteHarness) {
  describe('a like while the catalog deactivates the boundary', () => {
    let harness: WriteHarness
    let drain: ReturnType<typeof holdNextDrain> | undefined

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING, HARNESS_DESIGN])
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING, HARNESS_DESIGN])
      await seedPost(harness, SHINJI, 'eva01', HARNESS_DESIGN)
      drain = holdNextDrain(harness)
    })

    afterEach(async () => {
      await drain?.settle()
      vi.restoreAllMocks()
      await reactivateDesign(harness)
    })

    it('is refused with BoundaryNotFound before its subject is read', async () => {
      const cid = (
        await harness.recordRows(repoUriOf(SHINJI, 'eva01'))
      ).record!.cid.toString()
      const likeIn = (rkey: string) =>
        harness.call(CREATE, asMember(MISATO), {
          boundary: HARNESS_DESIGN,
          repo: MISATO,
          collection: LIKE,
          rkey,
          record: interaction(LIKE, { uri: repoUriOf(SHINJI, 'eva01'), cid }),
        })
      // The write cache lists the boundary for a member only after a write.
      expect((await likeIn('eva-warm')).status).toBe(200)
      await drain!.deactivate(HARNESS_DESIGN)

      const response = await likeIn('eva-window')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'BoundaryNotFound' })
    })
  })
}

function defineLegacyEntryPoints(getHarness: () => WriteHarness) {
  describe('the legacy entry points', () => {
    let harness: WriteHarness
    let cid: string
    const claim = {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: [{ value: HARNESS_ENGINEERING }],
    }

    beforeEach(async () => {
      harness = getHarness()
      await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      cid = await seedPost(harness, SHINJI, 'eva01')
    })

    const legacyLike = (collection: string) =>
      interaction(
        collection,
        { uri: repoUriOf(SHINJI, 'eva01'), cid },
        { boundary: claim },
      )

    it.each(INTERACTIONS)(
      'refuses a legacy createRecord of a %s with the prefix error',
      async (collection) => {
        const response = await harness.call(LEGACY_CREATE, asMember(MISATO), {
          repo: MISATO,
          collection,
          rkey: 'eva-legacy',
          record: legacyLike(collection),
        })

        expect(response.status).toBe(400)
        expect(response.body).toEqual({
          error: 'InvalidCollection',
          message: PREFIX_ERROR,
        })
      },
    )

    it.each(INTERACTIONS)(
      'refuses a legacy deleteRecord of a %s with the prefix error',
      async (collection) => {
        const response = await harness.call(LEGACY_DELETE, asMember(MISATO), {
          repo: MISATO,
          collection,
          rkey: 'eva-legacy',
        })

        expect(response.status).toBe(400)
        expect(response.body).toEqual({
          error: 'InvalidCollection',
          message: PREFIX_ERROR,
        })
      },
    )

    it.each(INTERACTIONS)(
      'refuses a direct legacy updateRecord of a %s with the prefix error',
      async (collection) => {
        await expect(
          updateRecord(
            harness.ctx,
            {
              repo: MISATO,
              collection,
              rkey: 'eva-legacy',
              record: legacyLike(collection),
            },
            MISATO,
          ),
        ).rejects.toMatchObject({
          customErrorName: 'InvalidCollection',
          message: PREFIX_ERROR,
        })
      },
    )

    it.each(INTERACTIONS)(
      'refuses a direct legacy batch with a %s with the prefix error',
      async (collection) => {
        await expect(
          applyWritesBatch(harness.ctx, MISATO, [
            {
              action: 'create',
              collection,
              rkey: 'eva-legacy',
              record: legacyLike(collection),
            },
          ]),
        ).rejects.toMatchObject({
          customErrorName: 'InvalidCollection',
          message: PREFIX_ERROR,
        })
      },
    )

    it('refuses a legacy applyWrites over http with a like and stores nothing', async () => {
      const root = await harness.repoRoot(MISATO)

      const response = await harness.call(
        LEGACY_APPLY_WRITES,
        asMember(MISATO),
        {
          repo: MISATO,
          writes: [
            {
              $type: 'com.atproto.repo.applyWrites#create',
              collection: LIKE,
              rkey: 'eva-legacy',
              value: legacyLike(LIKE),
            },
          ],
        },
      )

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidCollection',
        message: PREFIX_ERROR,
      })
      expect(await harness.repoRoot(MISATO)).toEqual(root)
    })

    it.each([
      ['an unlisted zone.stratos collection', 'zone.stratos.feed.angel'],
      ['an unlisted app.bsky collection', 'app.bsky.feed.post'],
    ])(
      'keeps the space-type message for %s in a legacy batch',
      async (_name, collection) => {
        const response = await harness.call(
          LEGACY_APPLY_WRITES,
          asMember(MISATO),
          {
            repo: MISATO,
            writes: [
              {
                $type: 'com.atproto.repo.applyWrites#create',
                collection,
                rkey: 'eva-legacy',
                value: { $type: collection, boundary: claim },
              },
            ],
          },
        )

        expect(response.status).toBe(400)
        expect(response.body).toEqual({
          error: 'InvalidCollection',
          message: `Collection ${collection} is not allowed in space type ${HOSTED_SPACE_TYPE}`,
        })
      },
    )

    it.each([
      ['before', ['zone.stratos.feed.angel', LIKE]],
      ['after', [LIKE, 'zone.stratos.feed.angel']],
    ])(
      'names the unlisted collection when it comes %s a like in a legacy batch',
      async (_name, collections) => {
        const attempt = applyWritesBatch(
          harness.ctx,
          MISATO,
          collections.map((collection, index) => ({
            action: 'create' as const,
            collection,
            rkey: `eva-legacy-${index}`,
            record: { $type: collection, boundary: claim },
          })),
        )

        await expect(attempt).rejects.toMatchObject({
          customErrorName: 'InvalidCollection',
          message: `Collection zone.stratos.feed.angel is not allowed in space type ${HOSTED_SPACE_TYPE}`,
        })
      },
    )

    it('still accepts a legacy batch of a post', async () => {
      const result = await applyWritesBatch(harness.ctx, MISATO, [
        {
          action: 'create',
          collection: POST,
          rkey: 'eva-legacy',
          record: {
            $type: POST,
            text: 'Sortie',
            createdAt: '1996-10-04T00:00:00.000Z',
            boundary: claim,
          },
        },
      ])

      expect(result.results).toHaveLength(1)
    })

    it('rejects with an InvalidRequestError, never a server error', async () => {
      const attempt = applyWritesBatch(harness.ctx, MISATO, [
        {
          action: 'create',
          collection: LIKE,
          rkey: 'eva-legacy',
          record: legacyLike(LIKE),
        },
      ])

      await expect(attempt).rejects.toBeInstanceOf(InvalidRequestError)
    })
  })
}

describe('the space type declaration', () => {
  it('lists the post, like and repost collections in the repo file', () => {
    const declaration = JSON.parse(readFileSync(DECLARATION_PATH, 'utf8'))

    expect(declaration.defs.main.collections).toEqual([POST, LIKE, REPOST])
  })
})

describe('interactions over http on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineAcceptedInteractions(() => harness)
  defineSubjectRefusals(() => harness)
  defineSpaceFormInteractions(() => harness)
  defineCatalogWindow(() => harness)
  defineLegacyEntryPoints(() => harness)
})

describe('interactions over http on postgres', () => {
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
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
  }, 60_000)

  afterEach(async () => {
    await harness.close()
  })

  it.each(INTERACTIONS)(
    'accepts a %s of a visible post',
    async (collection) => {
      const cid = await seedPost(harness, SHINJI, 'eva01')

      const response = await harness.call(CREATE, asMember(MISATO), {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection,
        rkey: 'eva-like',
        record: interaction(collection, {
          uri: repoUriOf(SHINJI, 'eva01'),
          cid,
        }),
      })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ validationStatus: 'valid' })
    },
  )

  it.each(INTERACTIONS)(
    'refuses a %s of a missing actor store and of a missing post with one body',
    async (collection) => {
      const cid = await seedPost(harness, SHINJI, 'eva01')
      const subjects = [
        { uri: repoUriOf('did:plc:gendo-ikari', 'eva13'), cid },
        { uri: repoUriOf(SHINJI, 'eva99'), cid },
        { uri: repoUriOf(SHINJI, 'eva01'), cid: STALE_CID },
      ]

      for (const [index, subject] of subjects.entries()) {
        const response = await harness.call(CREATE, asMember(MISATO), {
          boundary: HARNESS_ENGINEERING,
          repo: MISATO,
          collection,
          rkey: `eva-like-${index}`,
          record: interaction(collection, subject),
        })

        expect(response.status).toBe(400)
        expect(response.body).toEqual(SUBJECT_BODY)
      }
    },
  )

  it('keeps a legacy batch of a like refused with the prefix error', async () => {
    await expect(
      applyWritesBatch(harness.ctx, MISATO, [
        {
          action: 'create',
          collection: LIKE,
          rkey: 'eva-legacy',
          record: interaction(
            LIKE,
            { uri: repoUriOf(SHINJI, 'eva01'), cid: STALE_CID },
            {
              boundary: {
                $type: 'zone.stratos.boundary.defs#Domains',
                values: [{ value: HARNESS_ENGINEERING }],
              },
            },
          ),
        },
      ]),
    ).rejects.toMatchObject({
      customErrorName: 'InvalidCollection',
      message: PREFIX_ERROR,
    })
  })
})
