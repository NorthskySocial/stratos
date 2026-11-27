import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { InvalidRequestError } from '@atproto/xrpc-server'
import {
  formatRecordUri,
  StratosValidationError,
  StratosValidator,
} from '@northskysocial/stratos-core'
import { validateRecordInBoundary } from '../src/api/records/validation.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startPostgresWriteHarness,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import { startLabelRoute, type LabelRoute } from './helpers/label-route.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'

const COLLECTION = 'app.bsky.feed.repost'
const SUBJECT_ERROR = 'The subject must be a post in this boundary'
const SHINJI = 'did:plc:shinji-ikari'
const ASUKA = 'did:plc:asuka-langley'
const REI = 'did:plc:rei-ayanami'
const KAWORU = 'did:plc:kaworu-nagisa'
const MISATO = 'did:plc:misato-katsuragi'
const MAKOTO = 'did:plc:makoto-hyuga'
const STALE_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const PUT = 'zone.stratos.repo.putRecord'

const repoUriOf = (author: string, rkey: string, collection = POST) =>
  `at://${author}/${collection}/${rkey}`

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

const repost = (subject: unknown, extra: Record<string, unknown> = {}) => ({
  $type: COLLECTION,
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

interface Refusal {
  status: unknown
  name: string | undefined
  message: string
}

async function refusalOf(attempt: Promise<void>): Promise<Refusal> {
  try {
    await attempt
  } catch (err) {
    if (err instanceof InvalidRequestError) {
      return {
        status: err.type,
        name: err.customErrorName,
        message: err.message,
      }
    }
    throw err
  }
  throw new Error('the record was accepted')
}

function defineRepostRuleCases(getHarness: () => WriteHarness) {
  let harness: WriteHarness
  let currentCid: string

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING, HARNESS_DESIGN])
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(REI, [HARNESS_DESIGN])
    currentCid = await seedPost(harness, SHINJI, 'eva01')
  })

  const validate = (record: unknown, boundary = HARNESS_ENGINEERING) =>
    validateRecordInBoundary(harness.ctx, COLLECTION, record, boundary)

  const goodSubject = () => ({
    uri: repoUriOf(SHINJI, 'eva01'),
    cid: currentCid,
  })

  describe('an eligible subject', () => {
    it('passes for a visible post held only in the boundary', async () => {
      await expect(validate(repost(goodSubject()))).resolves.toBeUndefined()
    })

    it('passes for a post of a pds-custody member of the boundary in space form', async () => {
      const subject = { uri: spaceUriOf(ASUKA, 'eva02'), cid: currentCid }

      await expect(validate(repost(subject))).resolves.toBeUndefined()
    })

    it('passes whatever the lexicon would say of the rest of the record', async () => {
      const record = repost(goodSubject(), { createdAt: 7, via: 'nowhere' })

      await expect(validate(record)).resolves.toBeUndefined()
    })

    it('reads the current cid after a put', async () => {
      const put = await harness.call(PUT, asMember(SHINJI), {
        boundary: HARNESS_ENGINEERING,
        repo: SHINJI,
        collection: POST,
        rkey: 'eva01',
        record: {
          $type: POST,
          text: 'sortie again',
          createdAt: '1996-10-04T00:00:00.000Z',
        },
      })
      const newCid = (put.body as { cid: string }).cid

      await expect(
        validate(repost({ uri: repoUriOf(SHINJI, 'eva01'), cid: newCid })),
      ).resolves.toBeUndefined()
    })
  })

  describe('an ineligible subject', () => {
    let labels: LabelRoute

    beforeEach(async () => {
      labels = await startLabelRoute(harness)
      await seedPost(harness, SHINJI, 'eva03')
      expect(await labels.takeDownRecord(repoUriOf(SHINJI, 'eva03'))).toBe(200)
      await seedPost(harness, SHINJI, 'eva04', HARNESS_DESIGN)
      await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
      const heldCid = await seedPost(harness, MISATO, 'eva05')
      heldAuthorSubject = { uri: repoUriOf(MISATO, 'eva05'), cid: heldCid }
      await harness.holdMember(MISATO)
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

    let heldAuthorSubject: unknown
    let unenrolledAuthorSubject: unknown

    it('is refused with one error, whatever is wrong with it', async () => {
      const subjects: Array<[string, unknown]> = [
        ['no subject', undefined],
        ['a subject that is a string', 'eva01'],
        ['a uri that is a number', { uri: 7 }],
        ['a cid that is a number', { uri: repoUriOf(SHINJI, 'eva01'), cid: 7 }],
        [
          'a handle authority',
          { uri: `at://shinji.nerv.tokyo.jp/${POST}/eva01`, cid: currentCid },
        ],
        [
          'a uri that is not canonical',
          { uri: `${repoUriOf(SHINJI, 'eva01')}/`, cid: currentCid },
        ],
        [
          'an actor store that does not exist',
          { uri: repoUriOf(KAWORU, 'eva13'), cid: currentCid },
        ],
        [
          'a record that does not exist',
          { uri: repoUriOf(SHINJI, 'eva99'), cid: currentCid },
        ],
        [
          'a record in another boundary',
          { uri: repoUriOf(SHINJI, 'eva04'), cid: currentCid },
        ],
        [
          'a record that was taken down',
          { uri: repoUriOf(SHINJI, 'eva03'), cid: currentCid },
        ],
        ['a held author', heldAuthorSubject],
        ['an author who is no longer enrolled', unenrolledAuthorSubject],
        [
          'a cid that is not the stored one',
          { uri: repoUriOf(SHINJI, 'eva01'), cid: STALE_CID },
        ],
        ['no cid', { uri: repoUriOf(SHINJI, 'eva01') }],
        [
          'a space of another service',
          {
            uri: spaceUriOf(ASUKA, 'eva02', {
              authority: 'did:web:seele.example',
            }),
          },
        ],
        [
          'a space of another type',
          {
            uri: spaceUriOf(ASUKA, 'eva02', {
              spaceType: 'zone.stratos.space.eva',
            }),
          },
        ],
        [
          'a space of another boundary',
          { uri: spaceUriOf(ASUKA, 'eva02', { skey: 'design' }) },
        ],
        [
          'a pds-custody author who is not a member of the boundary',
          { uri: spaceUriOf(REI, 'eva00') },
        ],
        [
          'a stratos-custody author in space form',
          { uri: spaceUriOf(SHINJI, 'eva01') },
        ],
        [
          'a space-form author with no enrollment',
          { uri: spaceUriOf(KAWORU, 'eva13') },
        ],
        [
          'a collection that is not a post',
          {
            uri: spaceUriOf(ASUKA, 'eva02', {
              collection: 'app.bsky.feed.like',
            }),
          },
        ],
      ]

      const refusals = new Set<string>()
      for (const [name, subject] of subjects) {
        const refusal = await refusalOf(validate(repost(subject)))
        expect(refusal, name).toEqual({
          status: 400,
          name: 'InvalidRecord',
          message: SUBJECT_ERROR,
        })
        refusals.add(JSON.stringify(refusal))
      }
      expect(refusals.size).toBe(1)
    })

    it('is refused with the same error in a record whose lexicon problems are elsewhere', async () => {
      const broken = repost(
        { uri: repoUriOf(SHINJI, 'eva99') },
        { createdAt: 7 },
      )

      expect(await refusalOf(validate(broken))).toEqual({
        status: 400,
        name: 'InvalidRecord',
        message: SUBJECT_ERROR,
      })
    })

    it('refuses the cid a put replaced', async () => {
      const put = await harness.call(PUT, asMember(SHINJI), {
        boundary: HARNESS_ENGINEERING,
        repo: SHINJI,
        collection: POST,
        rkey: 'eva01',
        record: {
          $type: POST,
          text: 'sortie again',
          createdAt: '1996-10-04T00:00:00.000Z',
        },
      })
      expect(put.status).toBe(200)

      expect(await refusalOf(validate(repost(goodSubject())))).toMatchObject({
        message: SUBJECT_ERROR,
      })
    })
  })

  describe('outside the boundary pipeline', () => {
    it('fails closed in a legacy validation, which never resolves a subject', () => {
      const validator = new StratosValidator(harness.ctx.cfg.stratos)

      let caught: unknown
      try {
        validator.assertValid(repost(goodSubject()), COLLECTION)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(StratosValidationError)
      expect(caught).toMatchObject({
        code: 'InvalidSubject',
        message: SUBJECT_ERROR,
      })
    })
  })
}

describe('the repost rule on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineRepostRuleCases(() => harness)
})

describe('the repost rule on postgres', () => {
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

  defineRepostRuleCases(() => harness)
})
