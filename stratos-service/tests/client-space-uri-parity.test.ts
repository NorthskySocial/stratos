import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  boundaryToSpaceUri as coreBoundaryToSpaceUri,
  parseRecordUri as coreParseRecordUri,
  parseSpaceUri as coreParseSpaceUri,
} from '@northskysocial/stratos-core'
import {
  boundaryToSpaceUri as clientBoundaryToSpaceUri,
  parseSpaceRecordUri as clientParseSpaceRecordUri,
  parseSpaceUri as clientParseSpaceUri,
} from '@northskysocial/stratos-client'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'

const DID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:%-'
const SKEY_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~:-'

const charsFrom = (alphabet: string) => fc.constantFrom(...alphabet.split(''))

const serviceDid = fc
  .tuple(
    fc.stringMatching(/^[a-z]{1,8}$/),
    fc.array(charsFrom(DID_CHARS), { minLength: 1, maxLength: 40 }),
  )
  .map(([method, rest]) => `did:${method}:${rest.join('')}`)

const skey = fc
  .array(charsFrom(SKEY_CHARS), { minLength: 1, maxLength: 80 })
  .map((chars) => chars.join(''))

/** Mostly well formed, with the pieces the two formatters could judge differently. */
const nearValidBoundary = fc
  .tuple(
    fc.oneof(
      serviceDid,
      fc.constant('did:web:'),
      fc.constant('did:WEB:x'),
      fc.string(),
    ),
    fc.constantFrom('/', '', '//'),
    fc.oneof(
      skey,
      fc.constant('.'),
      fc.constant('..'),
      fc.constant(''),
      fc.string({ maxLength: 20 }),
      fc.string({ minLength: 513, maxLength: 520 }),
    ),
  )
  .map(([did, slash, name]) => `${did}${slash}${name}`)

const comparable = (
  result:
    | ReturnType<typeof coreBoundaryToSpaceUri>
    | ReturnType<typeof clientBoundaryToSpaceUri>,
) => (result.ok ? { ok: true, value: result.value } : { ok: false })

describe('client and core space URI formatting', () => {
  it('agree for valid boundaries', () => {
    fc.assert(
      fc.property(serviceDid, skey, (did, name) => {
        const boundary = `${did}/${name}`
        expect(
          comparable(clientBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
        ).toEqual(
          comparable(coreBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
        )
      }),
      { numRuns: 500 },
    )
  })

  it('agree on whether near-valid and arbitrary boundaries format at all', () => {
    fc.assert(
      fc.property(
        fc.oneof(nearValidBoundary, fc.string(), fc.string({ unit: 'binary' })),
        (boundary) => {
          expect(
            comparable(clientBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
          ).toEqual(
            comparable(coreBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
          )
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('agree for arbitrary space types', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(HOSTED_SPACE_TYPE),
          fc.string(),
          fc.stringMatching(/^[a-z]{2,6}(\.[a-z]{2,6}){1,3}$/),
        ),
        (spaceType) => {
          const boundary = 'did:web:nerv.example/geofront'
          expect(
            comparable(clientBoundaryToSpaceUri(boundary, spaceType)),
          ).toEqual(comparable(coreBoundaryToSpaceUri(boundary, spaceType)))
        },
      ),
      { numRuns: 500 },
    )
  })

  it('formats the known boundary the same way', () => {
    expect(
      clientBoundaryToSpaceUri(
        'did:web:nerv.example/geofront',
        HOSTED_SPACE_TYPE,
      ),
    ).toEqual({
      ok: true,
      value: 'at:space/did:web:nerv.example/zone.stratos.space.feed/geofront',
    })
  })
})

const CORPUS_URL = new URL(
  '../../test/spaces-alignment/november/fixtures/space-uri-conformance.json',
  import.meta.url,
)
const corpus = JSON.parse(readFileSync(CORPUS_URL, 'utf8')) as {
  spaces: Array<{ uri: string }>
  records: Array<{ uri: string }>
  repoRecords: Array<{ uri: string }>
  boundaries: Array<{ boundary: string; spaceType: string }>
  invalid: Array<{ input: string }>
}

const valueOrNull = <T>(
  result: { ok: true; value: T } | { ok: false },
): T | null => (result.ok ? result.value : null)

/** What both parsers say about one string, in one comparable shape. */
function bothParsers(input: string) {
  return {
    core: {
      space: valueOrNull(coreParseSpaceUri(input)),
      record: valueOrNull(coreParseRecordUri(input)),
    },
    client: {
      space: valueOrNull(clientParseSpaceUri(input)),
      record: valueOrNull(clientParseSpaceRecordUri(input)),
    },
  }
}

describe('client and core space URI parsing', () => {
  it('agree on every corpus string', () => {
    const inputs = [
      ...corpus.spaces,
      ...corpus.records,
      ...corpus.repoRecords,
    ].map((entry) => entry.uri)
    inputs.push(...corpus.invalid.map((entry) => entry.input))
    for (const input of inputs) {
      const { core, client } = bothParsers(input)
      expect(client).toEqual(core)
    }
  })

  it('agree on every corpus boundary', () => {
    for (const { boundary, spaceType } of corpus.boundaries) {
      expect(comparable(clientBoundaryToSpaceUri(boundary, spaceType))).toEqual(
        comparable(coreBoundaryToSpaceUri(boundary, spaceType)),
      )
    }
  })

  const spaceType = fc.constantFrom(
    'zone.stratos.space.feed',
    'zone.stratos.space.chat',
    'com.example.crew',
  )
  const parts = fc.record({
    spaceDid: serviceDid,
    spaceType,
    skey,
    authorDid: serviceDid,
    collection: fc.constantFrom('zone.stratos.feed.post', 'app.bsky.feed.like'),
    rkey: skey,
  })
  const hexSafe = (did: string) => did.replace(/%/g, '%25')

  it('agree on generated valid part sets and their one-character corruptions', () => {
    fc.assert(
      fc.property(
        parts,
        fc.nat(),
        fc.constantFrom('/', '%', ':', ' ', '?', '#', 'é', '\ud800', 'a'),
        (generated, position, replacement) => {
          const safe = {
            ...generated,
            spaceDid: hexSafe(generated.spaceDid),
            authorDid: hexSafe(generated.authorDid),
          }
          const space = `at:space/${safe.spaceDid}/${safe.spaceType}/${safe.skey}`
          const record = `${space}/${safe.authorDid}/${safe.collection}/${safe.rkey}`
          for (const valid of [space, record]) {
            const { core, client } = bothParsers(valid)
            expect(client).toEqual(core)
            const at = position % valid.length
            const corrupted =
              valid.slice(0, at) + replacement + valid.slice(at + 1)
            const both = bothParsers(corrupted)
            expect(both.client).toEqual(both.core)
          }
          const parsed = bothParsers(record).core.record
          if (parsed !== null) expect(parsed).toEqual(safe)
        },
      ),
      { numRuns: 200 },
    )
  })
})
