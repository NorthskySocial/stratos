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
import {
  formatRecordUri,
  isEligibleSubject,
  type ExpectedSubject,
  type SubjectFacts,
} from '@northskysocial/stratos-core'
import { resolveReferencedRecord } from '../src/api/records/references.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_GENERAL,
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

const SHINJI = 'did:plc:shinji-ikari'
const ASUKA = 'did:plc:asuka-langley'
const REI = 'did:plc:rei-ayanami'
const KAWORU = 'did:plc:kaworu-nagisa'
const POST = 'zone.stratos.feed.post'
const CREATE = 'zone.stratos.repo.createRecord'
const PUT = 'zone.stratos.repo.putRecord'

const uriOf = (author: string, rkey: string) => `at://${author}/${POST}/${rkey}`

function spaceUriOf(
  author: string,
  rkey: string,
  overrides: { authority?: string; spaceType?: string; skey?: string } = {},
): string {
  const formatted = formatRecordUri({
    spaceDid: overrides.authority ?? HARNESS_SERVICE_DID,
    spaceType: overrides.spaceType ?? HOSTED_SPACE_TYPE,
    skey: overrides.skey ?? 'engineering',
    authorDid: author,
    collection: POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

function post(text: string) {
  return { $type: POST, text, createdAt: '1996-10-04T00:00:00.000Z' }
}

function expectedFor(cid: string | undefined): ExpectedSubject {
  return {
    boundary: HARNESS_ENGINEERING,
    serviceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    collections: [POST],
    cid,
  }
}

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
    record: post(`sortie ${rkey}`),
  })
  expect(created.status).toBe(200)
  return (created.body as { cid: string }).cid
}

const UNRESOLVABLE: SubjectFacts = { form: 'unresolvable' }

function defineResolutionCases(getHarness: () => WriteHarness) {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = getHarness()
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  const resolve = (subject: unknown) =>
    resolveReferencedRecord(harness.ctx, subject)

  it('resolves a visible post and finds it eligible', async () => {
    const cid = await seedPost(harness, SHINJI, 'eva01')
    const subject = { uri: uriOf(SHINJI, 'eva01'), cid }

    const facts = await resolve(subject)

    expect(facts).toEqual({
      form: 'repo',
      uri: uriOf(SHINJI, 'eva01'),
      author: SHINJI,
      collection: POST,
      storedCid: cid,
      boundaries: [HARNESS_ENGINEERING],
      authorActive: true,
      authorCustody: 'stratos',
    })
    expect(isEligibleSubject(facts, expectedFor(cid))).toBe(true)
  })

  it('reports the boundary rows of a post held in another boundary', async () => {
    const cid = await seedPost(harness, SHINJI, 'eva01', HARNESS_DESIGN)

    const facts = await resolve({ uri: uriOf(SHINJI, 'eva01'), cid })

    expect(facts).toMatchObject({ form: 'repo', boundaries: [HARNESS_DESIGN] })
    expect(isEligibleSubject(facts, expectedFor(cid))).toBe(false)
  })

  it('finds a missing record unresolvable', async () => {
    const cid = await seedPost(harness, SHINJI, 'eva01')

    expect(await resolve({ uri: uriOf(SHINJI, 'eva99'), cid })).toEqual(
      UNRESOLVABLE,
    )
  })

  it('finds a record in a missing actor store unresolvable without throwing', async () => {
    const cid = await seedPost(harness, SHINJI, 'eva01')

    expect(await resolve({ uri: uriOf(REI, 'eva00'), cid })).toEqual(
      UNRESOLVABLE,
    )
  })

  it('finds a record whose author has no enrollment unresolvable', async () => {
    await harness.ctx.actorStore.create(KAWORU)

    expect(await resolve({ uri: uriOf(KAWORU, 'eva13') })).toEqual(UNRESOLVABLE)
  })

  it('finds a taken-down record unresolvable', async () => {
    const cid = await seedPost(harness, SHINJI, 'eva01')
    const labels = await startLabelRoute(harness)
    try {
      expect(await labels.takeDownRecord(uriOf(SHINJI, 'eva01'))).toBe(200)

      expect(await resolve({ uri: uriOf(SHINJI, 'eva01'), cid })).toEqual(
        UNRESOLVABLE,
      )
    } finally {
      await labels.close()
    }
  })

  it('reports a held author as inactive and the subject ineligible', async () => {
    const cid = await seedPost(harness, SHINJI, 'eva01')
    await harness.holdMember(SHINJI)

    const facts = await resolve({ uri: uriOf(SHINJI, 'eva01'), cid })

    expect(facts).toMatchObject({ form: 'repo', authorActive: false })
    expect(isEligibleSubject(facts, expectedFor(cid))).toBe(false)
  })

  it('reads the current cid after a put and ignores the old one', async () => {
    const firstCid = await seedPost(harness, SHINJI, 'eva01')
    const put = await harness.call(PUT, asMember(SHINJI), {
      boundary: HARNESS_ENGINEERING,
      repo: SHINJI,
      collection: POST,
      rkey: 'eva01',
      record: post('sortie again'),
    })
    expect(put.status).toBe(200)
    const currentCid = (put.body as { cid: string }).cid
    expect(currentCid).not.toBe(firstCid)

    const facts = await resolve({ uri: uriOf(SHINJI, 'eva01'), cid: firstCid })

    expect(facts).toMatchObject({ form: 'repo', storedCid: currentCid })
    expect(isEligibleSubject(facts, expectedFor(currentCid))).toBe(true)
    expect(isEligibleSubject(facts, expectedFor(firstCid))).toBe(false)
  })

  it('finds a pds-custody author in repo form unresolvable: Stratos hosts no repo for them', async () => {
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])

    expect(await resolve({ uri: uriOf(ASUKA, 'eva02') })).toEqual(UNRESOLVABLE)
  })

  describe('in space form', () => {
    beforeEach(async () => {
      await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
    })

    it('accepts a pds-custody member of the boundary', async () => {
      const uri = spaceUriOf(ASUKA, 'eva02')

      const facts = await resolve({ uri })

      expect(facts).toEqual({
        form: 'space',
        uri,
        authority: HARNESS_SERVICE_DID,
        spaceType: HOSTED_SPACE_TYPE,
        skey: 'engineering',
        author: ASUKA,
        collection: POST,
        authorActive: true,
        authorCustody: 'pds',
        authorBoundaries: [HARNESS_ENGINEERING, HARNESS_GENERAL],
      })
      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(true)
    })

    it('does not compare a cid', async () => {
      const facts = await resolve({
        uri: spaceUriOf(ASUKA, 'eva02'),
        cid: 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a',
      })

      expect(isEligibleSubject(facts, expectedFor('another'))).toBe(true)
    })

    it('finds a member of another boundary only ineligible', async () => {
      await harness.enrollPdsCustodyMember(REI, [HARNESS_DESIGN])

      const facts = await resolve({ uri: spaceUriOf(REI, 'eva00') })

      expect(facts).toMatchObject({ form: 'space', author: REI })
      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(false)
    })

    it('finds a held member ineligible', async () => {
      await harness.holdMember(ASUKA)

      const facts = await resolve({ uri: spaceUriOf(ASUKA, 'eva02') })

      expect(facts).toMatchObject({ form: 'space', authorActive: false })
      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(false)
    })

    it('finds a stratos-custody author ineligible in space form', async () => {
      const facts = await resolve({ uri: spaceUriOf(SHINJI, 'eva01') })

      expect(facts).toMatchObject({ form: 'space', authorCustody: 'stratos' })
      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(false)
    })

    it('finds an author with no enrollment unresolvable', async () => {
      expect(await resolve({ uri: spaceUriOf(KAWORU, 'eva13') })).toEqual(
        UNRESOLVABLE,
      )
    })

    it('finds a space of another service ineligible', async () => {
      const facts = await resolve({
        uri: spaceUriOf(ASUKA, 'eva02', { authority: 'did:web:seele.example' }),
      })

      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(false)
    })

    it('finds a space of another type ineligible', async () => {
      const facts = await resolve({
        uri: spaceUriOf(ASUKA, 'eva02', {
          spaceType: 'zone.stratos.space.eva',
        }),
      })

      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(false)
    })

    it('finds a space of another boundary ineligible', async () => {
      const facts = await resolve({
        uri: spaceUriOf(ASUKA, 'eva02', { skey: 'design' }),
      })

      expect(isEligibleSubject(facts, expectedFor(undefined))).toBe(false)
    })
  })

  describe('with a uri that is not canonical or not a string', () => {
    it.each([
      ['a handle authority', `at://shinji.nerv.tokyo.jp/${POST}/eva01`],
      ['a trailing slash', `${uriOf(SHINJI, 'eva01')}/`],
      ['a query', `${uriOf(SHINJI, 'eva01')}?unit=1`],
      ['a fragment', `${uriOf(SHINJI, 'eva01')}#unit`],
      ['an extra segment', `${uriOf(SHINJI, 'eva01')}/unit`],
      ['a collection only', `at://${SHINJI}/${POST}`],
      ['a space uri with a trailing slash', `${spaceUriOf(ASUKA, 'eva02')}/`],
      ['plain text', 'Sortie'],
      ['an empty string', ''],
    ])('finds %s unresolvable', async (_name, uri) => {
      await seedPost(harness, SHINJI, 'eva01')

      expect(await resolve({ uri })).toEqual(UNRESOLVABLE)
    })

    it.each([
      ['a number', 7],
      ['null', null],
      ['an object', { $link: 'eva01' }],
      ['an array', [uriOf(SHINJI, 'eva01')]],
      ['a boolean', true],
      ['absent', undefined],
    ])('finds a uri that is %s unresolvable', async (_name, uri) => {
      expect(await resolve({ uri, cid: 'bafy' })).toEqual(UNRESOLVABLE)
    })

    it.each([
      ['a number', 7],
      ['null', null],
      ['an object', {}],
    ])('finds a cid that is %s unresolvable', async (_name, cid) => {
      await seedPost(harness, SHINJI, 'eva01')

      expect(await resolve({ uri: uriOf(SHINJI, 'eva01'), cid })).toEqual(
        UNRESOLVABLE,
      )
    })

    it.each([
      ['a string', 'eva01'],
      ['null', null],
      ['a number', 1],
      ['absent', undefined],
      ['an array', []],
    ])('finds a subject that is %s unresolvable', async (_name, subject) => {
      expect(await resolve(subject)).toEqual(UNRESOLVABLE)
    })

    it('never throws for any subject value', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.anything(),
            fc.record(
              { uri: fc.anything(), cid: fc.anything() },
              { requiredKeys: [] },
            ),
            fc.record({
              uri: fc.string({ maxLength: 60 }),
              cid: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
            }),
          ),
          async (subject) => {
            const facts = await resolve(subject)

            expect(['repo', 'space', 'unresolvable']).toContain(facts.form)
          },
        ),
        { numRuns: 100 },
      )
    })
  })
}

describe('referenced records on sqlite', () => {
  let harness: WriteHarness

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  defineResolutionCases(() => harness)
})

describe('referenced records on postgres', () => {
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

  defineResolutionCases(() => harness)
})
