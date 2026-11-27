import { describe, expect, it } from 'vitest'
import {
  isSyntacticDid,
  isValidNsidStr,
  isValidRkey,
  isValidSkey,
  parseCanonicalRepoUri,
  parseCanonicalSpaceRecordUri,
  parseLabelSubject,
  parseRecordUri,
  parseSpaceUri,
  RECORD_SUBJECT_TYPE,
  spaceUriToBoundary,
  StratosValidationError,
  StratosValidator,
  boundaryToSpaceUri,
} from '../src/index.js'
import type { StratosConfig } from '../src/index.js'
import { recordUriCollection } from '../src/validation/post-rules.js'

const SPIKE = 'did:plc:spikespiegel'
const SPACE = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
const SPACE_RECORD = `${SPACE}/${SPIKE}/zone.stratos.feed.post/swordfish`
const CUSTODY_RECORD = `at://${SPIKE}/zone.stratos.feed.post/swordfish`

const UNSEEN_CHARACTERS = [
  ['a line feed', '\n'],
  ['a carriage return', '\r'],
  ['a carriage return and line feed', '\r\n'],
  ['a line separator', '\u2028'],
  ['a paragraph separator', '\u2029'],
  ['a NUL', '\u0000'],
  ['a tab', '\t'],
] as const

const PLACEMENTS = [
  ['trailing', (base: string, inserted: string) => base + inserted],
  ['leading', (base: string, inserted: string) => inserted + base],
  [
    'inside',
    (base: string, inserted: string) =>
      base.slice(0, 3) + inserted + base.slice(3),
  ],
] as const

const cases = UNSEEN_CHARACTERS.flatMap(([label, inserted]) =>
  PLACEMENTS.map(
    ([where, place]) => [`${label}, ${where}`, inserted, place] as const,
  ),
)

describe('core parsers refuse a line terminator or control character anywhere', () => {
  const refusals: Array<[string, string, (value: string) => boolean]> = [
    ['parseSpaceUri', SPACE, (value) => parseSpaceUri(value).ok],
    ['parseRecordUri', SPACE_RECORD, (value) => parseRecordUri(value).ok],
    [
      'parseCanonicalSpaceRecordUri',
      SPACE_RECORD,
      (value) => parseCanonicalSpaceRecordUri(value) !== null,
    ],
    [
      'parseCanonicalRepoUri',
      CUSTODY_RECORD,
      (value) => parseCanonicalRepoUri(value) !== null,
    ],
    [
      'spaceUriToBoundary',
      SPACE,
      (value) => spaceUriToBoundary(value, 'did:web:bebop.example').ok,
    ],
    [
      'boundaryToSpaceUri',
      'did:web:bebop.example/crew',
      (value) => boundaryToSpaceUri(value, 'zone.stratos.space.feed').ok,
    ],
    [
      'parseLabelSubject of a custody record',
      CUSTODY_RECORD,
      (value) =>
        parseLabelSubject({ $type: RECORD_SUBJECT_TYPE, uri: value }).ok,
    ],
    [
      'parseLabelSubject of a space record',
      SPACE_RECORD,
      (value) =>
        parseLabelSubject({ $type: RECORD_SUBJECT_TYPE, uri: value }).ok,
    ],
    ['isSyntacticDid', SPIKE, isSyntacticDid],
    ['isValidNsidStr', 'zone.stratos.feed.post', isValidNsidStr],
    ['isValidRkey', 'swordfish', isValidRkey],
    ['isValidSkey', 'crew', isValidSkey],
  ]

  it.each(refusals)('%s takes the plain value', (_name, base, accepts) => {
    expect(accepts(base)).toBe(true)
  })

  it.each(
    refusals.flatMap(([name, base, accepts]) =>
      cases.map(
        ([label, inserted, place]) =>
          [name, label, place(base, inserted), accepts] as const,
      ),
    ),
  )('%s refuses %s', (_name, _label, input, accepts) => {
    expect(accepts(input)).toBe(false)
  })
})

describe('a reply target must be spelled as a record address', () => {
  const config: StratosConfig = {
    serviceDid: 'did:web:nerv.tokyo.jp',
    allowedDomains: ['did:web:nerv.tokyo.jp/example-com'],
    retentionDays: 90,
  }
  const validator = new StratosValidator(config)
  const replyTo = (uri: string) => () =>
    validator.assertValid(
      {
        text: 'See you, space cowboy.',
        boundary: { values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }] },
        reply: { parent: { uri }, root: { uri } },
      },
      'zone.stratos.feed.post',
    )

  // Upstream @atproto/syntax 0.0.0-spaces-alpha-20261117141222, run on each
  // input: `ensureValidAtUri` refuses all of them ("Disallowed characters in
  // ATURI (ASCII)"), while the `AtUri` constructor reads the collection shown.
  const outsideTheGrammar: Array<[string, string, string]> = [
    [
      'a NUL after the record key',
      `${CUSTODY_RECORD}\u0000`,
      'zone.stratos.feed.post',
    ],
    [
      'a NUL inside the record key',
      `at://${SPIKE}/zone.stratos.feed.post/sword\u0000fish`,
      'zone.stratos.feed.post',
    ],
    [
      'a control character after the record key',
      `${CUSTODY_RECORD}\u0001`,
      'zone.stratos.feed.post',
    ],
    [
      'a NUL after the collection',
      `at://${SPIKE}/zone.stratos.feed.post\u0000/swordfish`,
      'zone.stratos.feed.post\u0000',
    ],
    [
      'an angle bracket after the record key',
      `${CUSTODY_RECORD}<`,
      'zone.stratos.feed.post',
    ],
  ]

  it('names the collection of the plain custody record and accepts a reply to it', () => {
    expect(recordUriCollection(CUSTODY_RECORD)).toBe('zone.stratos.feed.post')
    expect(StratosValidator.isStratosUri(CUSTODY_RECORD)).toBe(true)
    expect(replyTo(CUSTODY_RECORD)).not.toThrow()
  })

  it.each(outsideTheGrammar)(
    'names no collection for a custody URI with %s',
    (_label, uri) => {
      expect(recordUriCollection(uri)).toBeUndefined()
      expect(StratosValidator.isStratosUri(uri)).toBe(false)
    },
  )

  it.each(outsideTheGrammar)(
    'refuses a reply to a custody URI with %s',
    (_label, uri) => {
      expect(replyTo(uri)).toThrow(StratosValidationError)
      expect(replyTo(uri)).toThrow('cannot reply to a non-stratos record')
    },
  )

  it.each(outsideTheGrammar)(
    'still refuses a public post that embeds a custody URI with %s',
    (_label, uri, upstreamCollection) => {
      const embedsStratos = upstreamCollection.startsWith('zone.stratos.')
      const run = () =>
        StratosValidator.assertBskyNoCrossNamespaceEmbed(
          { embed: { record: { uri } } },
          'app.bsky.feed.post',
        )
      if (embedsStratos) expect(run).toThrow(StratosValidationError)
      else expect(run).not.toThrow()
    },
  )
})
