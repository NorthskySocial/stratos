import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  boundaryToSpaceUri,
  formatRecordUri,
  formatSpaceUri,
  parseRecordUri,
  parseSpaceUri,
  spaceUriToBoundary,
} from '../src'

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

interface Corpus {
  spaces: SpaceCase[]
  records: RecordCase[]
  repoRecords: Array<{ name: string; uri: string }>
  boundaries: Array<{
    name: string
    boundary: string
    spaceType: string
    uri: string
  }>
  invalid: Array<{
    name: string
    input: string
    as: 'space' | 'record' | 'both'
    legacy: boolean
  }>
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus

describe('space uri conformance corpus', () => {
  it('has cases in every section', () => {
    expect(corpus.spaces.length).toBeGreaterThan(0)
    expect(corpus.records.length).toBeGreaterThan(0)
    expect(corpus.repoRecords.length).toBeGreaterThan(0)
    expect(corpus.boundaries.length).toBeGreaterThan(0)
    expect(corpus.invalid.length).toBeGreaterThan(0)
  })

  it.each(corpus.spaces.map((entry) => [entry.name, entry] as const))(
    'parses and formats the space: %s',
    (_name, entry) => {
      expect(parseSpaceUri(entry.uri)).toEqual({
        ok: true,
        value: {
          spaceDid: entry.authority,
          spaceType: entry.spaceType,
          skey: entry.skey,
        },
      })
      expect(
        formatSpaceUri({
          spaceDid: entry.authority,
          spaceType: entry.spaceType,
          skey: entry.skey,
        }),
      ).toEqual({ ok: true, value: entry.uri })
    },
  )

  it.each(corpus.records.map((entry) => [entry.name, entry] as const))(
    'parses and formats the record: %s',
    (_name, entry) => {
      const parts = {
        spaceDid: entry.authority,
        spaceType: entry.spaceType,
        skey: entry.skey,
        authorDid: entry.author,
        collection: entry.collection,
        rkey: entry.rkey,
      }
      expect(parseRecordUri(entry.uri)).toEqual({ ok: true, value: parts })
      expect(formatRecordUri(parts)).toEqual({ ok: true, value: entry.uri })
    },
  )

  it.each(corpus.invalid.map((entry) => [entry.name, entry] as const))(
    'refuses the invalid input: %s',
    (_name, entry) => {
      if (entry.as !== 'record')
        expect(parseSpaceUri(entry.input).ok).toBe(false)
      if (entry.as !== 'space')
        expect(parseRecordUri(entry.input).ok).toBe(false)
    },
  )

  it.each(corpus.repoRecords.map((entry) => [entry.name, entry] as const))(
    'refuses the custody record as a space or record uri: %s',
    (_name, entry) => {
      expect(parseSpaceUri(entry.uri).ok).toBe(false)
      expect(parseRecordUri(entry.uri).ok).toBe(false)
    },
  )

  it.each(corpus.boundaries.map((entry) => [entry.name, entry] as const))(
    'maps the boundary both ways: %s',
    (_name, entry) => {
      const serviceDid = entry.boundary.slice(0, entry.boundary.indexOf('/'))
      expect(boundaryToSpaceUri(entry.boundary, entry.spaceType)).toEqual({
        ok: true,
        value: entry.uri,
      })
      expect(spaceUriToBoundary(entry.uri, serviceDid)).toEqual({
        ok: true,
        value: entry.boundary,
      })
    },
  )
})
