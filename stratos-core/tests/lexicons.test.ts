import { lexiconDoc } from '@atproto/lexicon'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stratosLexicons } from '../src/lexicons'

const LEXICONS_DIR = fileURLToPath(new URL('../../lexicons', import.meta.url))

function walkJson(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walkJson(full))
    else if (entry.endsWith('.json')) found.push(full)
  }
  return found
}

const files = walkJson(LEXICONS_DIR)

/**
 * Space-type declarations live in `lexicons-spaces/`, not here: they use
 * `"type": "space"` from the spaces reference spec, which is not an atproto
 * Lexicon primary type, so `@atproto/lexicon` rejects the document and
 * `XrpcServer` throws if handed one. Keeping them out of `lexicons/` means
 * everything in this directory is a real, registrable lexicon. They are
 * covered by space-type-declaration.test.ts.
 */
describe('lexicon documents', () => {
  it('finds lexicon files on disk', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => [path.relative(LEXICONS_DIR, f), f]))(
    '%s is a valid lexicon document',
    (_name, file) => {
      const doc: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const result = lexiconDoc.safeParse(doc)
      expect(result.success ? null : result.error.issues[0]?.message).toBeNull()
    },
  )

  it('registers every lexicon on disk with the runtime provider', () => {
    const onDisk = files
      .map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { id: string }).id)
      .sort()
    const registered = stratosLexicons
      .map((doc) => doc.id)
      .filter((id) => id.startsWith('zone.stratos.'))
      .sort()

    expect(registered).toEqual(onDisk)
  })
})
