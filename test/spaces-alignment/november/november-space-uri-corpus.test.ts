import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
)
const SPACE_PREFIX = 'at:space/'
const REPO_PREFIX = 'at://'
const MAX_CASES = 80
const LEGACY_SPACE_URI = /at:\/\/[^"\s]*\/space\//

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

interface BoundaryCase {
  name: string
  boundary: string
  spaceType: string
  uri: string
}

interface InvalidCase {
  name: string
  input: string
  as: 'space' | 'record' | 'both'
  legacy: boolean
}

interface Corpus {
  header: { classification: string; generator: string }
  spaces: SpaceCase[]
  records: RecordCase[]
  repoRecords: RepoRecordCase[]
  boundaries: BoundaryCase[]
  invalid: InvalidCase[]
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8')) as T
}

const corpus = readFixture<Corpus>('space-uri-conformance.json')

function spaceUriOf(parts: SpaceCase): string {
  return `${SPACE_PREFIX}${[parts.authority, parts.spaceType, parts.skey].join('/')}`
}

describe('space uri conformance corpus', () => {
  it('is hand derived and stays within the case budget', () => {
    const total =
      corpus.spaces.length +
      corpus.records.length +
      corpus.repoRecords.length +
      corpus.boundaries.length +
      corpus.invalid.length
    expect(corpus.header.classification).toBe('target-uri-conformance')
    expect(corpus.header.generator).toBe('hand-derived')
    expect(total).toBeLessThanOrEqual(MAX_CASES)
  })

  it('writes each space as the prefix plus its parts joined by a slash', () => {
    expect(corpus.spaces.length).toBeGreaterThan(0)
    const wrong = corpus.spaces
      .filter((entry) => entry.uri !== spaceUriOf(entry))
      .map((entry) => entry.name)
    expect(wrong).toEqual([])
  })

  it('writes each record as its space plus the author, collection and rkey', () => {
    expect(corpus.records.length).toBeGreaterThan(0)
    const wrong = corpus.records
      .filter(
        (entry) =>
          entry.uri !==
          `${spaceUriOf(entry)}/${[entry.author, entry.collection, entry.rkey].join('/')}`,
      )
      .map((entry) => entry.name)
    expect(wrong).toEqual([])
  })

  it('keeps a distinct author on at least one record', () => {
    expect(
      corpus.records.some((entry) => entry.author !== entry.authority),
    ).toBe(true)
    expect(
      corpus.records.some((entry) => entry.author === entry.authority),
    ).toBe(true)
  })

  it('maps each boundary to the space made of its service did and domain', () => {
    expect(corpus.boundaries.length).toBeGreaterThan(0)
    const wrong = corpus.boundaries
      .filter((entry) => {
        const slash = entry.boundary.indexOf('/')
        const serviceDid = entry.boundary.slice(0, slash)
        const domain = entry.boundary.slice(slash + 1)
        return (
          slash === -1 ||
          entry.uri !==
            `${SPACE_PREFIX}${serviceDid}/${entry.spaceType}/${domain}`
        )
      })
      .map((entry) => entry.name)
    expect(wrong).toEqual([])
  })

  it('keeps custody record uris on the at:// scheme with three parts', () => {
    expect(corpus.repoRecords.length).toBeGreaterThan(0)
    const wrong = corpus.repoRecords
      .filter(
        (entry) =>
          !entry.uri.startsWith(REPO_PREFIX) ||
          entry.uri.slice(REPO_PREFIX.length).split('/').length !== 3 ||
          entry.uri !==
            `${REPO_PREFIX}${[entry.author, entry.collection, entry.rkey].join('/')}`,
      )
      .map((entry) => entry.name)
    expect(wrong).toEqual([])
  })

  it('gives every case a unique name', () => {
    const names = [
      ...corpus.spaces,
      ...corpus.records,
      ...corpus.repoRecords,
      ...corpus.boundaries,
      ...corpus.invalid,
    ].map((entry) => entry.name)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
  })

  it('holds the three target cases', () => {
    const target = readFixture<{ cases: Array<{ uri: string }> }>(
      'target-uri-cases.json',
    )
    const held = new Set([
      ...corpus.spaces.map((entry) => entry.uri),
      ...corpus.records.map((entry) => entry.uri),
    ])
    expect(target.cases).toHaveLength(3)
    expect(target.cases.filter((entry) => !held.has(entry.uri))).toEqual([])
  })

  it('starts every legacy input with the at:// scheme and only those', () => {
    const legacy = corpus.invalid.filter((entry) => entry.legacy)
    expect(legacy.length).toBeGreaterThan(0)
    expect(legacy.filter((entry) => !entry.input.startsWith('at://'))).toEqual(
      [],
    )
    const unmarked = corpus.invalid
      .filter((entry) => !entry.legacy && LEGACY_SPACE_URI.test(entry.input))
      .map((entry) => entry.name)
    expect(unmarked).toEqual([])
  })

  it('names the parsers each invalid input must fail', () => {
    const wrong = corpus.invalid
      .filter((entry) => !['space', 'record', 'both'].includes(entry.as))
      .map((entry) => entry.name)
    expect(wrong).toEqual([])
  })
})
