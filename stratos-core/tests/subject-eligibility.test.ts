import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  formatRecordUri,
  isEligibleSubject,
  parseCanonicalRepoUri,
  parseCanonicalSpaceRecordUri,
  parseRecordUri,
  type ExpectedSubject,
  type RepoSubjectFacts,
  type SpaceSubjectFacts,
  type SubjectFacts,
} from '../src/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const BOUNDARY = `${SERVICE_DID}/engineering`
const SPACE_TYPE = 'zone.stratos.space.feed'
const POST = 'zone.stratos.feed.post'
const POST_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const OTHER_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const SHINJI = 'did:plc:shinji-ikari'
const ASUKA = 'did:plc:asuka-langley'

const expected: ExpectedSubject = {
  boundary: BOUNDARY,
  serviceDid: SERVICE_DID,
  spaceType: SPACE_TYPE,
  collections: [POST],
  cid: POST_CID,
}

const repoUri = (author: string, collection: string, rkey: string) =>
  `at://${author}/${collection}/${rkey}`

function spaceUri(parts: {
  authority: string
  spaceType: string
  skey: string
  author: string
  collection: string
  rkey: string
}): string {
  const formatted = formatRecordUri({
    spaceDid: parts.authority,
    spaceType: parts.spaceType,
    skey: parts.skey,
    authorDid: parts.author,
    collection: parts.collection,
    rkey: parts.rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

const eligibleRepoFacts: RepoSubjectFacts = {
  form: 'repo',
  uri: repoUri(SHINJI, POST, 'eva01'),
  author: SHINJI,
  collection: POST,
  storedCid: POST_CID,
  boundaries: [BOUNDARY],
  authorActive: true,
  authorCustody: 'stratos',
}

const eligibleSpaceFacts: SpaceSubjectFacts = {
  form: 'space',
  uri: spaceUri({
    authority: SERVICE_DID,
    spaceType: SPACE_TYPE,
    skey: 'engineering',
    author: ASUKA,
    collection: POST,
    rkey: 'eva02',
  }),
  authority: SERVICE_DID,
  spaceType: SPACE_TYPE,
  skey: 'engineering',
  author: ASUKA,
  collection: POST,
  authorActive: true,
  authorCustody: 'pds',
  authorBoundaries: [BOUNDARY],
}

const didSuffix = fc.stringMatching(/^[a-z][a-z0-9]{3,12}$/)
const author = didSuffix.map((suffix) => `did:plc:${suffix}`)
const rkey = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,15}$/)
const nsidName = fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/)
const otherNsid = fc
  .tuple(nsidName, nsidName, nsidName)
  .map(([first, second, name]) => `${first}.${second}.${name}`)
  .filter((nsid) => nsid !== POST)
const otherString = (excluded: string) =>
  fc.string({ maxLength: 40 }).filter((value) => value !== excluded)

describe('isEligibleSubject for a repo-form subject', () => {
  it('accepts a visible stratos-custody post held only in the boundary', () => {
    expect(isEligibleSubject(eligibleRepoFacts, expected)).toBe(true)
  })

  it('accepts any author and rkey that give a canonical uri', () => {
    fc.assert(
      fc.property(author, rkey, (did, key) => {
        const facts: RepoSubjectFacts = {
          ...eligibleRepoFacts,
          uri: repoUri(did, POST, key),
          author: did,
        }
        expect(isEligibleSubject(facts, expected)).toBe(true)
      }),
    )
  })

  it('is eligible for no unresolvable subject', () => {
    expect(isEligibleSubject({ form: 'unresolvable' }, expected)).toBe(false)
  })

  describe('with a single condition broken', () => {
    const brokenRepo: Array<{
      name: string
      broken: fc.Arbitrary<[SubjectFacts, ExpectedSubject]>
    }> = [
      {
        name: 'the uri is not canonical',
        broken: fc
          .constantFrom(
            `${eligibleRepoFacts.uri}/`,
            `${eligibleRepoFacts.uri}?q=1`,
            `${eligibleRepoFacts.uri}#frag`,
            `${eligibleRepoFacts.uri}/extra`,
            `AT://${SHINJI}/${POST}/eva01`,
            ` ${eligibleRepoFacts.uri}`,
            `at://${SHINJI}/${POST}`,
            `at://shinji-ikari.nerv.tokyo.jp/${POST}/eva01`,
            `at://${SHINJI}/${POST}/a%20b`,
          )
          .map((uri) => [{ ...eligibleRepoFacts, uri }, expected]),
      },
      {
        name: 'the uri names another author than the facts',
        broken: author
          .filter((did) => did !== SHINJI)
          .map((did) => [{ ...eligibleRepoFacts, author: did }, expected]),
      },
      {
        name: 'the collection is not one the rule allows',
        broken: otherNsid.map((collection) => [
          {
            ...eligibleRepoFacts,
            uri: repoUri(SHINJI, collection, 'eva01'),
            collection,
          },
          expected,
        ]),
      },
      {
        name: 'the facts name another collection than the uri',
        broken: otherNsid.map((collection) => [
          { ...eligibleRepoFacts, collection },
          { ...expected, collections: [collection, POST] },
        ]),
      },
      {
        name: 'the stored cid differs from the cid the record claims',
        broken: otherString(POST_CID).map((storedCid) => [
          { ...eligibleRepoFacts, storedCid },
          expected,
        ]),
      },
      {
        name: 'the record claims no cid',
        broken: fc.constant([
          eligibleRepoFacts,
          { ...expected, cid: undefined },
        ]),
      },
      {
        name: 'the stored rows are anything but exactly the boundary',
        broken: fc
          .array(otherString(BOUNDARY), { maxLength: 3 })
          .chain((others) =>
            fc.constantFrom(
              others,
              [BOUNDARY, ...others.slice(0, 1)].concat(['x']),
              [BOUNDARY, BOUNDARY],
            ),
          )
          .filter((rows) => !(rows.length === 1 && rows[0] === BOUNDARY))
          .map((boundaries) => [
            { ...eligibleRepoFacts, boundaries },
            expected,
          ]),
      },
      {
        name: 'the author is not active',
        broken: fc.constant([
          { ...eligibleRepoFacts, authorActive: false },
          expected,
        ]),
      },
      {
        name: 'the author keeps their repo at a pds',
        broken: fc.constant([
          { ...eligibleRepoFacts, authorCustody: 'pds' },
          expected,
        ]),
      },
    ]

    it.each(brokenRepo)('is ineligible when $name', ({ broken }) => {
      fc.assert(
        fc.property(broken, ([facts, expectation]) => {
          expect(isEligibleSubject(facts, expectation)).toBe(false)
        }),
      )
    })

    it('is ineligible when the rows hold the boundary and another', () => {
      const facts = {
        ...eligibleRepoFacts,
        boundaries: [BOUNDARY, `${SERVICE_DID}/design`],
      }
      expect(isEligibleSubject(facts, expected)).toBe(false)
    })

    it('is ineligible when the boundary asked for is another', () => {
      const design = `${SERVICE_DID}/design`
      expect(
        isEligibleSubject(eligibleRepoFacts, { ...expected, boundary: design }),
      ).toBe(false)
    })
  })
})

describe('isEligibleSubject for a space-form subject', () => {
  it('accepts a pds-custody member post of this service in the boundary', () => {
    expect(isEligibleSubject(eligibleSpaceFacts, expected)).toBe(true)
  })

  it('does not compare the cid', () => {
    expect(
      isEligibleSubject(eligibleSpaceFacts, { ...expected, cid: undefined }),
    ).toBe(true)
    expect(
      isEligibleSubject(eligibleSpaceFacts, { ...expected, cid: OTHER_CID }),
    ).toBe(true)
  })

  it('accepts a member who holds the boundary among others', () => {
    fc.assert(
      fc.property(
        fc.array(otherString(BOUNDARY), { maxLength: 4 }),
        author,
        rkey,
        (others, did, key) => {
          const facts: SpaceSubjectFacts = {
            ...eligibleSpaceFacts,
            uri: spaceUri({
              authority: SERVICE_DID,
              spaceType: SPACE_TYPE,
              skey: 'engineering',
              author: did,
              collection: POST,
              rkey: key,
            }),
            author: did,
            authorBoundaries: [...others, BOUNDARY],
          }
          expect(isEligibleSubject(facts, expected)).toBe(true)
        },
      ),
    )
  })

  describe('with a single condition broken', () => {
    const rebuilt = (
      overrides: Partial<{
        authority: string
        spaceType: string
        skey: string
        collection: string
      }>,
    ): SpaceSubjectFacts => {
      const parts = {
        authority: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: 'engineering',
        author: ASUKA,
        collection: POST,
        rkey: 'eva02',
        ...overrides,
      }
      return { ...eligibleSpaceFacts, ...parts, uri: spaceUri(parts) }
    }

    const brokenSpace: Array<{
      name: string
      broken: fc.Arbitrary<[SubjectFacts, ExpectedSubject]>
    }> = [
      {
        name: 'the authority is another service',
        broken: author
          .map((did) => did.replace('did:plc:', 'did:web:') + '.example')
          .filter((authority) => authority !== SERVICE_DID)
          .map((authority) => [rebuilt({ authority }), expected]),
      },
      {
        name: 'the space type is another',
        broken: otherNsid.map((spaceType) => [
          rebuilt({ spaceType }),
          expected,
        ]),
      },
      {
        name: 'the skey names another boundary',
        broken: nsidName
          .filter((skey) => skey !== 'engineering')
          .map((skey) => [rebuilt({ skey }), expected]),
      },
      {
        name: 'the collection is not one the rule allows',
        broken: otherNsid.map((collection) => [
          rebuilt({ collection }),
          expected,
        ]),
      },
      {
        name: 'the author is not active',
        broken: fc.constant([
          { ...eligibleSpaceFacts, authorActive: false },
          expected,
        ]),
      },
      {
        name: 'the author keeps their repo at stratos',
        broken: fc.constant([
          { ...eligibleSpaceFacts, authorCustody: 'stratos' },
          expected,
        ]),
      },
      {
        name: 'the author does not hold the boundary',
        broken: fc
          .array(otherString(BOUNDARY), { maxLength: 4 })
          .map((authorBoundaries) => [
            { ...eligibleSpaceFacts, authorBoundaries },
            expected,
          ]),
      },
      {
        name: 'the facts name another author than the uri',
        broken: author
          .filter((did) => did !== ASUKA)
          .map((did) => [{ ...eligibleSpaceFacts, author: did }, expected]),
      },
      {
        name: 'the uri is not canonical',
        broken: fc
          .constantFrom(
            `${eligibleSpaceFacts.uri}/`,
            `${eligibleSpaceFacts.uri}#frag`,
            `${eligibleSpaceFacts.uri}/extra`,
            eligibleSpaceFacts.uri.replace('at://', 'AT://'),
            eligibleSpaceFacts.uri.replace('/space/', '/Space/'),
            eligibleSpaceFacts.uri.replace(
              `/${SPACE_TYPE}/`,
              `/${SPACE_TYPE}/./`,
            ),
          )
          .map((uri) => [{ ...eligibleSpaceFacts, uri }, expected]),
      },
    ]

    it.each(brokenSpace)('is ineligible when $name', ({ broken }) => {
      fc.assert(
        fc.property(broken, ([facts, expectation]) => {
          expect(isEligibleSubject(facts, expectation)).toBe(false)
        }),
      )
    })

    it('is ineligible when the boundary asked for is another', () => {
      expect(
        isEligibleSubject(eligibleSpaceFacts, {
          ...expected,
          boundary: `${SERVICE_DID}/design`,
        }),
      ).toBe(false)
    })
  })
})

describe('isEligibleSubject on input of any shape', () => {
  const facts = (): fc.Arbitrary<unknown> =>
    fc.oneof(
      fc.anything(),
      fc.record(
        {
          form: fc.oneof(
            fc.constantFrom('repo', 'space', 'unresolvable'),
            fc.anything(),
          ),
          uri: fc.anything(),
          author: fc.anything(),
          authority: fc.anything(),
          spaceType: fc.anything(),
          skey: fc.anything(),
          collection: fc.anything(),
          storedCid: fc.anything(),
          boundaries: fc.anything(),
          authorBoundaries: fc.anything(),
          authorActive: fc.anything(),
          authorCustody: fc.anything(),
        },
        { requiredKeys: [] },
      ),
    )

  it('answers a boolean and never throws', () => {
    fc.assert(
      fc.property(facts(), (input) => {
        expect(typeof isEligibleSubject(input as SubjectFacts, expected)).toBe(
          'boolean',
        )
      }),
      { numRuns: 500 },
    )
  })
})

describe('the canonical uri parsers', () => {
  it('give the parts of a repo uri that rebuilds to the same string', () => {
    fc.assert(
      fc.property(author, rkey, (did, key) => {
        expect(parseCanonicalRepoUri(repoUri(did, POST, key))).toEqual({
          author: did,
          collection: POST,
          rkey: key,
        })
      }),
    )
  })

  it('refuse every string that is not a did-authority record uri in its own spelling', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        const parts = parseCanonicalRepoUri(text)
        if (parts) {
          expect(repoUri(parts.author, parts.collection, parts.rkey)).toBe(text)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('give the parts of a space record uri that formats back to the same string', () => {
    expect(parseCanonicalSpaceRecordUri(eligibleSpaceFacts.uri)).toEqual({
      spaceDid: SERVICE_DID,
      spaceType: SPACE_TYPE,
      skey: 'engineering',
      authorDid: ASUKA,
      collection: POST,
      rkey: 'eva02',
    })
  })

  it('refuse every other string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        expect(parseCanonicalSpaceRecordUri(text)).toBeNull()
      }),
      { numRuns: 500 },
    )
  })
})

describe('the canonical uri parsers on spellings that nearly pass', () => {
  const SPACE_PREFIX = `at://${SERVICE_DID}/space/${SPACE_TYPE}/engineering/${ASUKA}/${POST}`
  const spaceSuffixes = ['/eva02/', '/eva02?q=1', '/eva02#f', '/eva02//', '']

  it.each(spaceSuffixes)('refuse the space record uri ending %j', (suffix) => {
    expect(parseCanonicalSpaceRecordUri(`${SPACE_PREFIX}${suffix}`)).toBeNull()
  })

  it('accept a space record uri exactly when its parts parse, never one that parses but would be written differently', () => {
    const tokens = fc.constantFrom(
      SERVICE_DID,
      'did:web:seele.example',
      'did:plc:',
      'shinji.test',
      SPACE_TYPE,
      'zone',
      'engineering',
      'Engineering',
      '',
      ASUKA,
      POST,
      'app.bsky.feed.like',
      'eva02',
      '..',
    )
    const ending = fc.constantFrom('', '/', '?q=1', '#f', '/x')
    fc.assert(
      fc.property(
        fc.array(tokens, { minLength: 5, maxLength: 7 }),
        ending,
        (segments, tail) => {
          const text = `at://${segments.join('/')}${tail}`
          const parsed = parseRecordUri(text)

          expect(parseCanonicalSpaceRecordUri(text) !== null).toBe(parsed.ok)
          if (parsed.ok) {
            const formatted = formatRecordUri(parsed.value)
            expect(formatted.ok && formatted.value).toBe(text)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  const rejectedRepoUris = [
    [
      'a handle in place of a did',
      'at://shinji.test/zone.stratos.feed.post/eva01',
    ],
    ['an incomplete did', 'at://did:plc:/zone.stratos.feed.post/eva01'],
    ['an nsid with too few segments', `at://${SHINJI}/zone.post/eva01`],
    [
      'an nsid with a digit leading its name',
      `at://${SHINJI}/zone.stratos.feed.4post/eva01`,
    ],
    ['an rkey of two dots', `at://${SHINJI}/${POST}/..`],
    ['an rkey of one dot', `at://${SHINJI}/${POST}/.`],
    ['an rkey that is missing', `at://${SHINJI}/${POST}`],
    ['an rkey with a space', `at://${SHINJI}/${POST}/eva 01`],
    ['a trailing slash', `at://${SHINJI}/${POST}/eva01/`],
    ['a query', `at://${SHINJI}/${POST}/eva01?q=1`],
    ['a fragment', `at://${SHINJI}/${POST}/eva01#f`],
    ['an extra path segment', `at://${SHINJI}/${POST}/eva01/x`],
    ['no scheme', `${SHINJI}/${POST}/eva01`],
    ['text that is not a uri', 'not a uri'],
    ['the empty string', ''],
  ] as const

  it.each(rejectedRepoUris)('refuse a repo uri with %s', (_, uri) => {
    expect(parseCanonicalRepoUri(uri)).toBeNull()
  })

  it.each(rejectedRepoUris)(
    'never lets a subject with %s be eligible, even for a matching author and collection',
    (_, uri) => {
      const facts: RepoSubjectFacts = {
        ...eligibleRepoFacts,
        uri,
        author: uri.split('/')[2] ?? '',
        collection: POST,
      }

      expect(isEligibleSubject(facts, expected)).toBe(false)
    },
  )
})
