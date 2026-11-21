import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  parseCanonicalRepoUri,
  parseRecordUri as coreParseRecordUri,
} from '@northskysocial/stratos-core'
import { parseRecordAddress } from '@northskysocial/stratos-client'

const CORPUS_URL = new URL(
  '../../test/spaces-alignment/november/fixtures/space-uri-conformance.json',
  import.meta.url,
)
const corpus = JSON.parse(readFileSync(CORPUS_URL, 'utf8')) as {
  records: Array<{ uri: string }>
  repoRecords: Array<{ uri: string }>
  spaces: Array<{ uri: string }>
  invalid: Array<{ input: string }>
}

/** What stratos-core says about a record address, in the client's shape. */
function coreClassification(input: string) {
  const space = coreParseRecordUri(input)
  if (space.ok) {
    const { spaceDid, authorDid, ...rest } = space.value
    return { kind: 'space', authority: spaceDid, author: authorDid, ...rest }
  }
  const custody = parseCanonicalRepoUri(input)
  return custody === null ? null : { kind: 'custody', ...custody }
}

function clientClassification(input: string) {
  const result = parseRecordAddress(input)
  return result.ok ? result.value : null
}

const CUSTODY_URI_PREFIX = 'at://'
const SPACE_DID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:%-'
// stratos-core reads a custody authority through AtUri, whose host pattern
// takes `did:` followed only by letters, digits, `:`, `%` and `-`, or a name
// of letters, digits, `.`, `:` and `-`. A DID with `_`, or with both `.` and
// `%`, matches neither and is refused, while a bad percent escape without a
// `.` is accepted. Generated custody DIDs leave out `_` and `%` so they only
// meet inputs both sides judge alike; the tests below pin the rest.
const CUSTODY_DID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-'
const KEY_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~:-'
const charsFrom = (alphabet: string) => fc.constantFrom(...alphabet.split(''))

const didFrom = (alphabet: string) =>
  fc
    .tuple(
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.array(charsFrom(alphabet), { minLength: 1, maxLength: 30 }),
    )
    .map(
      ([method, rest]) => `did:${method}:${rest.join('').replace(/%/g, '%25')}`,
    )
const spaceDid = didFrom(SPACE_DID_CHARS)
const custodyDid = didFrom(CUSTODY_DID_CHARS)
const key = fc
  .array(charsFrom(KEY_CHARS), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(''))

/** A `%` placed here can make an escape or a `.` and `%` pair, which the two sides judge apart. */
function isInsideCustodyDid(address: string, at: number): boolean {
  if (!address.startsWith(CUSTODY_URI_PREFIX)) return false
  return (
    at >= CUSTODY_URI_PREFIX.length &&
    at < address.indexOf('/', CUSTODY_URI_PREFIX.length)
  )
}

const collection = fc.constantFrom(
  'zone.stratos.feed.post',
  'app.bsky.feed.like',
)

// Line terminators and control characters arrive with copied or pasted
// addresses; JavaScript's `$` must never let one through at the end.
const LINE_TERMINATORS = ['\n', '\r', '\r\n', '\u2028', '\u2029']
const CONTROL_CHARACTERS = ['\u0000', '\t', '\u000b', '\u000c', '\u0085']
const CORRUPTIONS = [
  ...['/', '%', ':', ' ', '?', '#', 'é', '\ud800', 'a'],
  ...LINE_TERMINATORS,
  ...CONTROL_CHARACTERS,
]

const validAddress = fc.oneof(
  fc
    .tuple(spaceDid, key, spaceDid, collection, key)
    .map(
      ([authority, skey, author, nsid, rkey]) =>
        `at:space/${authority}/zone.stratos.space.feed/${skey}/${author}/${nsid}/${rkey}`,
    ),
  fc
    .tuple(custodyDid, collection, key)
    .map(([author, nsid, rkey]) => `at://${author}/${nsid}/${rkey}`),
)

describe('client record address classifier against stratos-core', () => {
  it('agrees on every corpus string', () => {
    const inputs = [
      ...corpus.records,
      ...corpus.repoRecords,
      ...corpus.spaces,
    ].map((entry) => entry.uri)
    inputs.push(...corpus.invalid.map((entry) => entry.input))
    expect(inputs.length).toBeGreaterThan(50)
    for (const input of inputs) {
      expect(clientClassification(input)).toEqual(coreClassification(input))
    }
  })

  it('agrees on 200 generated addresses and their one-character corruptions', () => {
    fc.assert(
      fc.property(
        validAddress,
        fc.nat(),
        fc.constantFrom(...CORRUPTIONS),
        (address, position, replacement) => {
          expect(clientClassification(address)).toEqual(
            coreClassification(address),
          )
          const at = position % address.length
          if (replacement === '%' && isInsideCustodyDid(address, at)) return
          const corrupted =
            address.slice(0, at) + replacement + address.slice(at + 1)
          expect(clientClassification(corrupted)).toEqual(
            coreClassification(corrupted),
          )
        },
      ),
      { numRuns: 200 },
    )
  })

  it('agrees on 200 generated addresses with a character appended', () => {
    fc.assert(
      fc.property(
        validAddress,
        fc.constantFrom(...CORRUPTIONS),
        (address, appended) => {
          const extended = address + appended
          expect(clientClassification(extended)).toEqual(
            coreClassification(extended),
          )
        },
      ),
      { numRuns: 200 },
    )
  })

  // The client follows the DID grammar, so it accepts what AtUri's host
  // pattern refuses and refuses the bad escape AtUri lets through. The
  // generated test above avoids these inputs; they are pinned here so a change
  // on either side shows up.
  it.each([
    'at://did:plc:ab_cd/zone.stratos.feed.post/swordfish',
    'at://did:web:127.0.0.1%3A3100/zone.stratos.feed.post/swordfish',
    'at://did:web:bebop.example%3A3100/zone.stratos.feed.post/swordfish',
  ])('accepts a valid DID that stratos-core refuses: %s', (input) => {
    expect(coreClassification(input)).toBeNull()
    expect(clientClassification(input)).toMatchObject({ kind: 'custody' })
  })

  it('refuses a bad percent escape in a DID that stratos-core accepts', () => {
    const input = 'at://did:plc:ab%zz/zone.stratos.feed.post/swordfish'
    expect(coreClassification(input)).toMatchObject({ kind: 'custody' })
    expect(clientClassification(input)).toBeNull()
  })
})
