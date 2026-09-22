import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseRecordUri } from '@northskysocial/stratos-core'
import { decodeCursor, encodeCursor } from '../src/db/index.js'

interface CursorFixture {
  version: number
  cases: Array<{
    name: string
    input: string
    expected: { sortAt: string; uri: string } | null
  }>
}

interface SpaceRecordFixture {
  version: number
  valid: Array<{
    name: string
    input: string
    expected: {
      spaceDid: string
      spaceType: string
      skey: string
      authorDid: string
      collection: string
      rkey: string
    }
  }>
  invalid: Array<{ name: string; input: string }>
}

function readFixture(name: string): unknown {
  const path = fileURLToPath(
    new URL(`../testdata/conformance/v1/${name}`, import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('portable conformance fixtures', () => {
  it('preserves the cursor contract', () => {
    const fixture = readFixture('cursor.json') as CursorFixture
    expect(fixture.version).toBe(1)

    for (const testCase of fixture.cases) {
      expect(decodeCursor(testCase.input), testCase.name).toEqual(
        testCase.expected,
      )
      if (testCase.expected !== null) {
        expect(
          encodeCursor(testCase.expected.sortAt, testCase.expected.uri),
          testCase.name,
        ).toBe(testCase.input)
      }
    }
  })

  it('preserves space-record addressing', () => {
    const fixture = readFixture('space-record-uri.json') as SpaceRecordFixture
    expect(fixture.version).toBe(1)

    for (const testCase of fixture.valid) {
      expect(parseRecordUri(testCase.input), testCase.name).toEqual({
        ok: true,
        value: testCase.expected,
      })
    }
    for (const testCase of fixture.invalid) {
      expect(parseRecordUri(testCase.input).ok, testCase.name).toBe(false)
    }
  })
})
