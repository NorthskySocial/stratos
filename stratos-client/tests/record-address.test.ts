import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseRecordAddress } from '../src'

const CORPUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../test/spaces-alignment/november/fixtures/space-uri-conformance.json',
)

interface SpaceCase {
  name: string
  uri: string
  authority: string
  spaceType: string
  skey: string
}

interface RecordCase extends SpaceCase {
  author: string
  collection: string
  rkey: string
}

interface RepoRecordCase {
  name: string
  uri: string
  author: string
  collection: string
  rkey: string
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as {
  spaces: SpaceCase[]
  records: RecordCase[]
  repoRecords: RepoRecordCase[]
  invalid: Array<{
    name: string
    input: string
    as: 'space' | 'record' | 'both'
  }>
}

const FAYE = 'did:plc:fayevalentine'
const CUSTODY_POST = `at://${FAYE}/zone.stratos.feed.post/swordfish`
const SPACE_POST =
  'at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish'

const kindOf = (input: string): 'space' | 'custody' | 'refused' => {
  const result = parseRecordAddress(input)
  return result.ok ? result.value.kind : 'refused'
}

describe('record addresses in the corpus', () => {
  it.each(corpus.records.map((entry) => [entry.name, entry] as const))(
    'classifies the record as a space record: %s',
    (_name, entry) => {
      expect(parseRecordAddress(entry.uri)).toEqual({
        ok: true,
        value: {
          kind: 'space',
          authority: entry.authority,
          spaceType: entry.spaceType,
          skey: entry.skey,
          author: entry.author,
          collection: entry.collection,
          rkey: entry.rkey,
        },
      })
    },
  )

  it.each(corpus.repoRecords.map((entry) => [entry.name, entry] as const))(
    'classifies the record as a custody record: %s',
    (_name, entry) => {
      expect(parseRecordAddress(entry.uri)).toEqual({
        ok: true,
        value: {
          kind: 'custody',
          author: entry.author,
          collection: entry.collection,
          rkey: entry.rkey,
        },
      })
    },
  )

  it.each(corpus.spaces.map((entry) => [entry.name, entry] as const))(
    'refuses the space URI: %s',
    (_name, entry) => {
      expect(parseRecordAddress(entry.uri).ok).toBe(false)
    },
  )

  // An entry marked `as: "space"` is a well-formed record, only not a space.
  it.each(
    corpus.invalid
      .filter((entry) => entry.as !== 'space')
      .map((entry) => [entry.name, entry] as const),
  )('refuses the invalid input: %s', (_name, entry) => {
    const result = parseRecordAddress(entry.input)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0)
  })

  it('classifies the invalid entry that is only not a space as a record', () => {
    const notASpace = corpus.invalid.filter((entry) => entry.as === 'space')
    expect(notASpace.length).toBeGreaterThan(0)
    for (const entry of notASpace) {
      expect(kindOf(entry.input)).toBe('space')
    }
  })
})

// Each `upstream` value is what ensureValidAtUri and AtUri from the pinned
// upstream package (@atproto/syntax 0.0.0-spaces-alpha-20261117141222) said
// about the string. Upstream accepts any host and ignores the record key's
// grammar, so the classifier is stricter on purpose: it routes only a DID
// authority and exactly three parts.
const CUSTODY_TABLE: ReadonlyArray<{
  label: string
  input: string
  upstream: string
  kind: 'custody' | 'refused'
}> = [
  {
    label: 'custody post',
    input: CUSTODY_POST,
    upstream: 'valid',
    kind: 'custody',
  },
  {
    label: 'did:web with an encoded port',
    input: 'at://did:web:localhost%3A3100/app.bsky.feed.post/3kbebop',
    upstream: 'valid',
    kind: 'custody',
  },
  {
    label: 'handle authority',
    input: 'at://spike.bebop.example/zone.stratos.feed.post/swordfish',
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'one part',
    input: `at://${FAYE}`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'two parts',
    input: `at://${FAYE}/zone.stratos.feed.post`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'four parts',
    input: `${CUSTODY_POST}/extra`,
    upstream: 'throws: ATURI can not have more than two path segments',
    kind: 'refused',
  },
  {
    label: 'query',
    input: `${CUSTODY_POST}?x=1`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'fragment',
    input: `${CUSTODY_POST}#x`,
    upstream: 'throws: ATURI has invalid fragment (Invalid JSON pointer)',
    kind: 'refused',
  },
  {
    label: 'trailing slash',
    input: `${CUSTODY_POST}/`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'empty rkey',
    input: `at://${FAYE}/zone.stratos.feed.post/`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'rkey of two dots',
    input: `at://${FAYE}/zone.stratos.feed.post/..`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'collection that is not an NSID',
    input: `at://${FAYE}/post/swordfish`,
    upstream: 'throws: ATURI has invalid collection',
    kind: 'refused',
  },
  {
    label: 'bad escape in the DID',
    input: 'at://did:web:a%zz/zone.stratos.feed.post/swordfish',
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'leading space',
    input: ` ${CUSTODY_POST}`,
    upstream: 'throws: Disallowed characters in ATURI (ASCII)',
    kind: 'refused',
  },
  {
    label: 'upper-case scheme',
    input: CUSTODY_POST.replace('at://', 'AT://'),
    upstream: 'throws: ATURI must start with "at://"',
    kind: 'refused',
  },
  {
    label: 'space marker right after the scheme',
    input: 'at://space/did:web:bebop.example/zone.stratos.space.feed/crew',
    upstream: 'throws: ATURI can not have more than two path segments',
    kind: 'refused',
  },
  {
    label: 'rkey with a plus',
    input: `at://${FAYE}/zone.stratos.feed.post/a+b`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'rkey with a space',
    input: `at://${FAYE}/zone.stratos.feed.post/a b`,
    upstream: 'throws: Disallowed characters in ATURI (ASCII)',
    kind: 'refused',
  },
  {
    label: 'rkey with an encoded slash',
    input: `at://${FAYE}/zone.stratos.feed.post/a%2Fb`,
    upstream: 'valid',
    kind: 'refused',
  },
  {
    label: 'rkey with a replacement character',
    input: `at://${FAYE}/zone.stratos.feed.post/a�b`,
    upstream: 'throws: Disallowed characters in ATURI (ASCII)',
    kind: 'refused',
  },
]

describe('custody record addresses against the pinned upstream package', () => {
  it.each(CUSTODY_TABLE)(
    '$label: upstream $upstream, classifier $kind',
    ({ input, kind }) => {
      expect(kindOf(input)).toBe(kind)
    },
  )

  it('refuses without trimming or changing case', () => {
    expect(kindOf(`${CUSTODY_POST} `)).toBe('refused')
    expect(kindOf(SPACE_POST.toUpperCase())).toBe('refused')
    expect(kindOf(` ${SPACE_POST}`)).toBe('refused')
    expect(kindOf(CUSTODY_POST.replace('did:plc:', 'DID:plc:'))).toBe('refused')
  })

  it('keeps a custody author apart from a space authority', () => {
    const result = parseRecordAddress(SPACE_POST)
    expect(
      result.ok && result.value.kind === 'space' && result.value,
    ).toMatchObject({ authority: 'did:web:bebop.example', author: FAYE })
  })

  it('refuses a space URI that is a prefix or an extension of a record', () => {
    expect(kindOf(SPACE_POST.slice(0, SPACE_POST.lastIndexOf('/')))).toBe(
      'refused',
    )
    expect(kindOf(`${SPACE_POST}/extra`)).toBe('refused')
  })

  it('gives the same plain reason for every refusal, naming no format', () => {
    for (const input of ['', 'hello', `${CUSTODY_POST}/extra`, ' at:space/x']) {
      const result = parseRecordAddress(input)
      expect(result).toEqual({ ok: false, reason: 'not a record address' })
    }
  })
})

const THROWS = 'throws'

const decodeWithComponent = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return THROWS
  }
}

const decodeWithSearchParams = (raw: string): string =>
  new URLSearchParams(`topic=${raw}`).get('topic') ?? ''

// `raw` is the text after `topic=` in a link. Both decoders run in every
// browser and in Node with the same results: they are the WHATWG
// URLSearchParams and the ECMAScript decodeURIComponent. The rows where the two
// decoders disagree are the ones where the classifier is handed different strings.
const BROWSER_TABLE: ReadonlyArray<{
  label: string
  raw: string
  viaComponent: string
  viaSearchParams: string
  componentKind: 'space' | 'custody' | 'refused' | typeof THROWS
  searchParamsKind: 'space' | 'custody' | 'refused'
}> = [
  {
    label: 'a space record, fully encoded',
    raw: encodeURIComponent(SPACE_POST),
    viaComponent: SPACE_POST,
    viaSearchParams: SPACE_POST,
    componentKind: 'space',
    searchParamsKind: 'space',
  },
  {
    label: 'a custody record, not encoded',
    raw: CUSTODY_POST,
    viaComponent: CUSTODY_POST,
    viaSearchParams: CUSTODY_POST,
    componentKind: 'custody',
    searchParamsKind: 'custody',
  },
  {
    label: 'an encoded port in a custody DID, encoded once more by the link',
    raw: encodeURIComponent(
      'at://did:web:localhost%3A3100/app.bsky.feed.post/3kbebop',
    ),
    viaComponent: 'at://did:web:localhost%3A3100/app.bsky.feed.post/3kbebop',
    viaSearchParams: 'at://did:web:localhost%3A3100/app.bsky.feed.post/3kbebop',
    componentKind: 'custody',
    searchParamsKind: 'custody',
  },
  {
    label:
      'an encoded port written into the link once: both decoders turn %3A into a colon',
    raw: 'at://did:web:localhost%3A3100/app.bsky.feed.post/3kbebop',
    viaComponent: 'at://did:web:localhost:3100/app.bsky.feed.post/3kbebop',
    viaSearchParams: 'at://did:web:localhost:3100/app.bsky.feed.post/3kbebop',
    componentKind: 'custody',
    searchParamsKind: 'custody',
  },
  {
    label:
      'a plus in the record key: URLSearchParams makes a space, decodeURIComponent keeps the plus',
    raw: `${CUSTODY_POST}+2`,
    viaComponent: `${CUSTODY_POST}+2`,
    viaSearchParams: `${CUSTODY_POST} 2`,
    componentKind: 'refused',
    searchParamsKind: 'refused',
  },
  {
    label: 'an encoded plus: both give a plus',
    raw: `${CUSTODY_POST}%2B2`,
    viaComponent: `${CUSTODY_POST}+2`,
    viaSearchParams: `${CUSTODY_POST}+2`,
    componentKind: 'refused',
    searchParamsKind: 'refused',
  },
  {
    label:
      'a leading plus: URLSearchParams makes a leading space, neither is trimmed',
    raw: `+${CUSTODY_POST}`,
    viaComponent: `+${CUSTODY_POST}`,
    viaSearchParams: ` ${CUSTODY_POST}`,
    componentKind: 'refused',
    searchParamsKind: 'refused',
  },
  {
    label: 'an encoded slash in the record key makes a fourth part',
    raw: `at://${FAYE}/zone.stratos.feed.post/a%2Fb`,
    viaComponent: `at://${FAYE}/zone.stratos.feed.post/a/b`,
    viaSearchParams: `at://${FAYE}/zone.stratos.feed.post/a/b`,
    componentKind: 'refused',
    searchParamsKind: 'refused',
  },
  {
    label:
      'a bad escape: decodeURIComponent throws, URLSearchParams keeps the text',
    raw: 'at://did:web:a%zz/zone.stratos.feed.post/swordfish',
    viaComponent: THROWS,
    viaSearchParams: 'at://did:web:a%zz/zone.stratos.feed.post/swordfish',
    componentKind: THROWS,
    searchParamsKind: 'refused',
  },
  {
    label: 'a lone percent sign at the end',
    raw: `${CUSTODY_POST}%`,
    viaComponent: THROWS,
    viaSearchParams: `${CUSTODY_POST}%`,
    componentKind: THROWS,
    searchParamsKind: 'refused',
  },
  {
    label:
      'an encoded lone surrogate: decodeURIComponent throws, URLSearchParams gives a replacement character',
    raw: `${CUSTODY_POST}%ED%A0%80`,
    viaComponent: THROWS,
    viaSearchParams: `${CUSTODY_POST}���`,
    componentKind: THROWS,
    searchParamsKind: 'refused',
  },
  {
    label: 'an encoded trailing space is kept and refused',
    raw: `${CUSTODY_POST}%20`,
    viaComponent: `${CUSTODY_POST} `,
    viaSearchParams: `${CUSTODY_POST} `,
    componentKind: 'refused',
    searchParamsKind: 'refused',
  },
]

describe('record addresses as a browser hands them over', () => {
  it.each(BROWSER_TABLE)('$label', (row) => {
    const viaComponent = decodeWithComponent(row.raw)
    const viaSearchParams = decodeWithSearchParams(row.raw)
    expect(viaComponent).toBe(row.viaComponent)
    expect(viaSearchParams).toBe(row.viaSearchParams)
    expect(viaComponent === THROWS ? THROWS : kindOf(viaComponent)).toBe(
      row.componentKind,
    )
    expect(kindOf(viaSearchParams)).toBe(row.searchParamsKind)
  })

  it('differs between the two decoders on a plus, a bad escape and an encoded surrogate only', () => {
    const differing = BROWSER_TABLE.filter(
      (row) => row.viaComponent !== row.viaSearchParams,
    ).map((row) => row.raw)
    expect(differing).toEqual([
      `${CUSTODY_POST}+2`,
      `+${CUSTODY_POST}`,
      'at://did:web:a%zz/zone.stratos.feed.post/swordfish',
      `${CUSTODY_POST}%`,
      `${CUSTODY_POST}%ED%A0%80`,
    ])
  })

  it('refuses a string that holds a lone surrogate', () => {
    expect(kindOf(`${CUSTODY_POST}\ud800`)).toBe('refused')
    expect(kindOf(`at://${FAYE}/zone.stratos.feed.post/\udc00`)).toBe('refused')
  })
})
