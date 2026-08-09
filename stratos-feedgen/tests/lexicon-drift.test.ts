import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LexiconDoc } from '@atproto/lexicon'
import * as schemas from '../src/lexicon/schemas.js'

// schemas.ts (:8) names this directory as the source of truth for its
// hand-copied lexicon literals. This test proves the copies still match.
const lexiconDir = fileURLToPath(
  new URL('../../lexicons/zone/stratos/feedgen/', import.meta.url),
)

function exportNameFor(fileBaseName: string): string {
  return `${fileBaseName}Lexicon`
}

const jsonFiles = readdirSync(lexiconDir)
  .filter((entry) => entry.endsWith('.json'))
  .sort()

if (jsonFiles.length === 0) {
  // A misresolved path or an empty directory must not silently produce a
  // green run with zero assertions.
  throw new Error(
    `No lexicon JSON files found under ${lexiconDir} - lexicon-drift test cannot verify anything`,
  )
}

describe('feedgen inline lexicon copies match source-of-truth JSON', () => {
  for (const fileName of jsonFiles) {
    const baseName = fileName.replace(/\.json$/, '')
    const exportName = exportNameFor(baseName)

    it(`${exportName} matches lexicons/zone/stratos/feedgen/${fileName}`, () => {
      const raw = readFileSync(join(lexiconDir, fileName), 'utf-8')
      const expected = JSON.parse(raw) as LexiconDoc

      const actual = (schemas as Record<string, unknown>)[exportName]
      expect(
        actual,
        `schemas.ts has no export named "${exportName}" for ${fileName}`,
      ).toBeDefined()
      expect(actual).toStrictEqual(expected)
    })
  }
})

describe('every inline lexicon copy has a source-of-truth JSON file', () => {
  const sourceBaseNames = new Set(
    jsonFiles.map((fileName) => fileName.replace(/\.json$/, '')),
  )
  // Match on value shape, not export name, so unrelated exports that merely
  // end in "Lexicon" never synthesize a case demanding a nonexistent file.
  const isLexiconDoc = (value: unknown): value is LexiconDoc =>
    typeof value === 'object' &&
    value !== null &&
    (value as { lexicon?: unknown }).lexicon === 1 &&
    typeof (value as { id?: unknown }).id === 'string'

  const exportedLexiconNames = Object.entries(schemas)
    .filter(([, value]) => isLexiconDoc(value))
    .map(([name]) => name)

  for (const exportName of exportedLexiconNames) {
    const baseName = exportName.replace(/Lexicon$/, '')

    it(`${exportName} has a corresponding lexicons/zone/stratos/feedgen/${baseName}.json`, () => {
      expect([...sourceBaseNames]).toContain(baseName)
    })
  }
})
