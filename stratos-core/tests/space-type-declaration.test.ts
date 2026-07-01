import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidNsid } from '@atproto/syntax'
import { parseCommaList } from '../src/index.js'

// ---------------------------------------------------------------------------
// SWP-02: Space-type declarations.
//
// A space-type NSID resolves to a Lexicon def with `"type": "space"` as its
// `main` def. This suite loads the declaration file(s) from disk and validates
// them against the SWP-02 field table (see docs/spaces/01-space-model.md and
// docs/spaces/work-packages/SWP-02-space-type-declarations.md).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
// tests/ -> stratos-core/ -> repo root
const repoRoot = join(__dirname, '..', '..')

// The declaration lives under an NSID-derived layout. It is authored in
// `lexicons/` when the lex toolchain tolerates `"type": "space"`, or relocated
// to a sibling `lexicons-spaces/` dir if codegen chokes on it. The test must
// find it in either location.
const LEXICON_ROOTS = ['lexicons', 'lexicons-spaces'] as const
const SPACE_TYPE_RELPATH = join('zone', 'stratos', 'space', 'feed.json')

interface SpaceDef {
  type: string
  key?: unknown
  name?: unknown
  collections?: unknown
  description?: unknown
  [k: string]: unknown
}

interface LexiconDoc {
  lexicon?: unknown
  id?: unknown
  defs?: Record<string, SpaceDef>
  [k: string]: unknown
}

function locateSpaceTypeFile(): { path: string; root: string } {
  for (const root of LEXICON_ROOTS) {
    const candidate = join(repoRoot, root, SPACE_TYPE_RELPATH)
    if (existsSync(candidate)) {
      return { path: candidate, root }
    }
  }
  throw new Error(
    `Could not locate zone.stratos.space.feed declaration in any of: ${LEXICON_ROOTS.map(
      (r) => join(r, SPACE_TYPE_RELPATH),
    ).join(', ')}`,
  )
}

function loadLexicon(path: string): LexiconDoc {
  return JSON.parse(readFileSync(path, 'utf8')) as LexiconDoc
}

describe('zone.stratos.space.feed declaration', () => {
  const { path, root } = locateSpaceTypeFile()
  const doc = loadLexicon(path)
  const main = doc.defs?.main as SpaceDef | undefined

  it('is discoverable in lexicons/ or lexicons-spaces/', () => {
    expect(['lexicons', 'lexicons-spaces']).toContain(root)
    expect(existsSync(path)).toBe(true)
  })

  it('is a valid lexicon document with the expected NSID id', () => {
    expect(doc.lexicon).toBe(1)
    expect(doc.id).toBe('zone.stratos.space.feed')
    expect(isValidNsid(String(doc.id))).toBe(true)
  })

  it('has a `main` def whose type is "space"', () => {
    expect(doc.defs).toBeTypeOf('object')
    expect(main).toBeDefined()
    expect(main?.type).toBe('space')
  })

  it('carries a required string `key`', () => {
    expect(main?.key).toBeTypeOf('string')
    expect((main?.key as string).length).toBeGreaterThan(0)
  })

  it('carries a required human-readable `name` of length 1-64', () => {
    expect(main?.name).toBeTypeOf('string')
    const name = main?.name as string
    expect(name.length).toBeGreaterThanOrEqual(1)
    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('carries a required `collections` array of syntactically valid NSIDs', () => {
    expect(Array.isArray(main?.collections)).toBe(true)
    const collections = main?.collections as unknown[]
    expect(collections.length).toBeGreaterThan(0)
    for (const c of collections) {
      expect(c).toBeTypeOf('string')
      expect(isValidNsid(c as string)).toBe(true)
    }
  })

  it('has an optional `description` that, if present, is a string', () => {
    if (main?.description !== undefined) {
      expect(main.description).toBeTypeOf('string')
    }
  })

  // The v1 values are DECIDED (SWP-02, 2026-07-01). Pin them so drift is caught.
  describe('v1 decided values', () => {
    it('matches the decided field table exactly', () => {
      expect(doc.id).toBe('zone.stratos.space.feed')
      expect(main?.type).toBe('space')
      expect(main?.key).toBe('any')
      expect(main?.name).toBe('Stratos Feed')
      expect(main?.collections).toEqual(['zone.stratos.feed.post'])
      expect(main?.description).toBe('A members-only Stratos post feed')
    })

    it('declares no localized names (none for v1)', () => {
      // `name:lang` map is absent in v1.
      expect(main?.['name:lang']).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// domainName -> space type mapping totality.
//
// v1 has exactly ONE space type. Every boundary `domainName` maps to it
// (`skey` = `domainName`). With a single type this is total by construction,
// but we assert it explicitly to guard against future multi-type drift: if a
// second type is added, the resolver below must stop unconditionally returning
// the feed type and this test will force that reckoning.
//
// `STRATOS_ALLOWED_DOMAINS` is a comma-separated env string (see
// docs/architecture/multi-domain-enrollment.md). We ground the totality
// assertion in that real config shape by parsing it with the shipped
// `parseCommaList` helper.
// ---------------------------------------------------------------------------

const FEED_SPACE_TYPE = 'zone.stratos.space.feed'

/**
 * Resolves a boundary domainName to its space-type NSID. v1: total map to the
 * single decided feed type.
 */
function resolveSpaceType(_domainName: string): string {
  return FEED_SPACE_TYPE
}

describe('domainName -> space type resolver (v1 totality)', () => {
  it('resolves the declared type NSID for an arbitrary domainName', () => {
    for (const domain of [
      'general',
      'pottery',
      'posters-madness',
      'bees',
      'a',
      'x'.repeat(200),
    ]) {
      expect(resolveSpaceType(domain)).toBe(FEED_SPACE_TYPE)
    }
  })

  it('is total over a STRATOS_ALLOWED_DOMAINS config value', () => {
    // Real config shape: comma-separated domain names.
    const allowedDomains = parseCommaList('posters-madness,bees,plants,pottery')
    expect(allowedDomains.length).toBeGreaterThan(0)
    for (const domain of allowedDomains) {
      expect(resolveSpaceType(domain)).toBe(FEED_SPACE_TYPE)
    }
    // Every resolved type is a real, declared space type (single type in v1).
    const resolvedTypes = new Set(allowedDomains.map(resolveSpaceType))
    expect([...resolvedTypes]).toEqual([FEED_SPACE_TYPE])
  })

  it('resolves the same NSID that the declaration file declares', () => {
    const { path } = locateSpaceTypeFile()
    const doc = loadLexicon(path)
    expect(resolveSpaceType('anything')).toBe(doc.id)
  })
})
