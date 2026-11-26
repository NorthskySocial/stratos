import { describe, expect, it } from 'vitest'

import {
  boundaryToSpaceUri,
  parseRecordAddress,
  parseSpaceRecordUri,
  parseSpaceUri,
} from '../src'

const SPACE_PREFIX = 'at:space/'
const CUSTODY_PREFIX = 'at://'
const SPACE_PARTS = ['did:web:bebop.example', 'zone.stratos.space.feed', 'crew']
const SPACE_RECORD_PARTS = [
  ...SPACE_PARTS,
  'did:plc:spikespiegel',
  'zone.stratos.feed.post',
  'swordfish',
]
const CUSTODY_RECORD_PARTS = [
  'did:plc:spikespiegel',
  'zone.stratos.feed.post',
  'swordfish',
]
const SPACE_TYPE = 'zone.stratos.space.feed'

// JavaScript's `$` without the `m` flag matches only at the end of the input,
// unlike Python's or PCRE's, which also match before a final line feed. These
// cases keep it that way for every character a copied or pasted address may
// carry.
const UNSEEN_CHARACTERS = [
  ['a line feed', '\n'],
  ['a carriage return', '\r'],
  ['a carriage return and line feed', '\r\n'],
  ['a line separator', '\u2028'],
  ['a paragraph separator', '\u2029'],
  ['a NUL', '\u0000'],
  ['a tab', '\t'],
] as const

const join = (prefix: string, parts: readonly string[]) =>
  prefix + parts.join('/')

/** The address with `inserted` before it, after it, and inside and after each part. */
function placements(
  prefix: string,
  parts: readonly string[],
  inserted: string,
): Array<[string, string]> {
  const withPart = (index: number, text: string) =>
    join(
      prefix,
      parts.map((part, at) => (at === index ? text : part)),
    )
  return [
    ['leading', inserted + join(prefix, parts)],
    ['trailing', join(prefix, parts) + inserted],
    ...parts.flatMap((part, index): Array<[string, string]> => {
      const middle = Math.floor(part.length / 2)
      return [
        [
          `inside part ${index + 1}`,
          withPart(
            index,
            part.slice(0, middle) + inserted + part.slice(middle),
          ),
        ],
        [`after part ${index + 1}`, withPart(index, part + inserted)],
      ]
    }),
  ]
}

const casesFor = (prefix: string, parts: readonly string[]) =>
  UNSEEN_CHARACTERS.flatMap(([label, inserted]) =>
    placements(prefix, parts, inserted).map(
      ([where, input]) => [`${label}, ${where}`, input] as const,
    ),
  )

describe('the parsers take the plain addresses these cases start from', () => {
  it('parses each base address', () => {
    expect(parseSpaceUri(join(SPACE_PREFIX, SPACE_PARTS)).ok).toBe(true)
    expect(parseSpaceRecordUri(join(SPACE_PREFIX, SPACE_RECORD_PARTS)).ok).toBe(
      true,
    )
    expect(
      parseRecordAddress(join(SPACE_PREFIX, SPACE_RECORD_PARTS)),
    ).toMatchObject({ ok: true, value: { kind: 'space' } })
    expect(
      parseRecordAddress(join(CUSTODY_PREFIX, CUSTODY_RECORD_PARTS)),
    ).toMatchObject({ ok: true, value: { kind: 'custody' } })
    expect(
      boundaryToSpaceUri('did:web:bebop.example/crew', SPACE_TYPE),
    ).toEqual({ ok: true, value: join(SPACE_PREFIX, SPACE_PARTS) })
  })
})

describe('a line terminator or control character anywhere is refused, not trimmed', () => {
  it.each(casesFor(SPACE_PREFIX, SPACE_PARTS))(
    'parseSpaceUri refuses a space URI with %s',
    (_label, input) => {
      expect(parseSpaceUri(input).ok).toBe(false)
    },
  )

  it.each(casesFor(SPACE_PREFIX, SPACE_RECORD_PARTS))(
    'parseSpaceRecordUri refuses a space record URI with %s',
    (_label, input) => {
      expect(parseSpaceRecordUri(input).ok).toBe(false)
    },
  )

  it.each(casesFor(SPACE_PREFIX, SPACE_RECORD_PARTS))(
    'parseRecordAddress refuses a space record address with %s',
    (_label, input) => {
      expect(parseRecordAddress(input)).toEqual({
        ok: false,
        reason: 'not a record address',
      })
    },
  )

  it.each(casesFor(CUSTODY_PREFIX, CUSTODY_RECORD_PARTS))(
    'parseRecordAddress refuses a custody record address with %s',
    (_label, input) => {
      expect(parseRecordAddress(input)).toEqual({
        ok: false,
        reason: 'not a record address',
      })
    },
  )

  it.each(
    UNSEEN_CHARACTERS.flatMap(([label, inserted]) => [
      [
        `${label} after the boundary name`,
        `did:web:bebop.example/crew${inserted}`,
        SPACE_TYPE,
      ],
      [
        `${label} inside the service DID`,
        `did:web:bebop${inserted}.example/crew`,
        SPACE_TYPE,
      ],
      [
        `${label} after the space type`,
        'did:web:bebop.example/crew',
        `${SPACE_TYPE}${inserted}`,
      ],
    ]),
  )('boundaryToSpaceUri refuses %s', (_label, boundary, spaceType) => {
    expect(boundaryToSpaceUri(boundary, spaceType).ok).toBe(false)
  })
})
