import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { boundaryToSpaceUri, parseSpaceRecordUri, parseSpaceUri } from '../src'

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

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as {
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
  }>
}

describe('space uri corpus on the client', () => {
  it.each(corpus.spaces.map((entry) => [entry.name, entry] as const))(
    'parses the space: %s',
    (_name, entry) => {
      expect(parseSpaceUri(entry.uri)).toEqual({
        ok: true,
        value: {
          spaceDid: entry.authority,
          spaceType: entry.spaceType,
          skey: entry.skey,
        },
      })
      expect(parseSpaceRecordUri(entry.uri).ok).toBe(false)
    },
  )

  it.each(corpus.records.map((entry) => [entry.name, entry] as const))(
    'parses the record: %s',
    (_name, entry) => {
      expect(parseSpaceRecordUri(entry.uri)).toEqual({
        ok: true,
        value: {
          spaceDid: entry.authority,
          spaceType: entry.spaceType,
          skey: entry.skey,
          authorDid: entry.author,
          collection: entry.collection,
          rkey: entry.rkey,
        },
      })
      expect(parseSpaceUri(entry.uri).ok).toBe(false)
    },
  )

  it.each(corpus.invalid.map((entry) => [entry.name, entry] as const))(
    'refuses the invalid input: %s',
    (_name, entry) => {
      const refusal = (result: { ok: boolean; reason?: string }) => {
        expect(result.ok).toBe(false)
        expect((result as { reason: string }).reason.length).toBeGreaterThan(0)
      }
      if (entry.as !== 'record') refusal(parseSpaceUri(entry.input))
      if (entry.as !== 'space') refusal(parseSpaceRecordUri(entry.input))
    },
  )

  it.each(corpus.repoRecords.map((entry) => [entry.name, entry] as const))(
    'refuses the custody record: %s',
    (_name, entry) => {
      expect(parseSpaceUri(entry.uri).ok).toBe(false)
      expect(parseSpaceRecordUri(entry.uri).ok).toBe(false)
    },
  )

  it.each(corpus.boundaries.map((entry) => [entry.name, entry] as const))(
    'formats the boundary: %s',
    (_name, entry) => {
      expect(boundaryToSpaceUri(entry.boundary, entry.spaceType)).toEqual({
        ok: true,
        value: entry.uri,
      })
    },
  )

  it('refuses a percent sign without two hex digits in a did part', () => {
    expect(
      parseSpaceUri('at:space/did:web:a%zz/zone.stratos.space.feed/crew').ok,
    ).toBe(false)
    expect(
      boundaryToSpaceUri('did:web:a%2/crew', 'zone.stratos.space.feed').ok,
    ).toBe(false)
  })
})
