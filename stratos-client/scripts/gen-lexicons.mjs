// Generates src/lexicons.gen.ts by inlining the Stratos lexicon JSON documents
// into a browser-safe TypeScript module.
//
// The bundle is inlined (rather than importing JSON at runtime) so the published
// package works from its compiled dist/ output without shipping JSON assets.
//
// Run with: pnpm --filter @northskysocial/stratos-client lexgen

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const lexiconDirs = [
  resolve(scriptDir, '../../lexicons/zone/stratos'),
  resolve(scriptDir, '../../lexicons-spaces/zone/stratos'),
]
const outFile = resolve(scriptDir, '../src/lexicons.gen.ts')

function collectJsonFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) {
      found.push(...collectJsonFiles(fullPath))
    } else if (entry.endsWith('.json')) {
      found.push(fullPath)
    }
  }
  return found
}

const docs = lexiconDirs
  .flatMap(collectJsonFiles)
  .map((file) => {
    const raw = readFileSync(file, 'utf-8').trim()
    const id = JSON.parse(raw).id
    if (typeof id !== 'string') {
      throw new Error(`Lexicon ${file} is missing a string "id"`)
    }
    return { id, raw }
  })
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const banner = `/* eslint-disable */
// AUTO-GENERATED FILE — DO NOT EDIT.
// Regenerate with: pnpm --filter @northskysocial/stratos-client lexgen
// Source: lexicons*/zone/stratos/**/*.json
`

const body = `import type { LexiconDoc } from '@atproto/lexicon'

export const stratosLexicons: LexiconDoc[] = [
${docs.map((doc) => doc.raw).join(',\n')},
] as unknown as LexiconDoc[]
`

writeFileSync(outFile, `${banner}\n${body}`)
console.log(`Wrote ${docs.length} Stratos lexicons to ${outFile}`)
