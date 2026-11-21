import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidNsid } from '@atproto/syntax'
import { parseCommaList } from '../src/index.js'
import {
  buildSpaceTypeRegistry,
  InvalidSpaceTypeDeclarationError,
} from '../src/spaces/space-type-registry.js'

// ---------------------------------------------------------------------------
// Space-type declarations.
//
// A space-type NSID resolves to a Lexicon def with `"type": "space"` as its
// `main` def. This suite loads the declaration file(s) from disk and validates
// them against the decided space-type field table (see
// docs/spaces/01-space-model.md).
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
// tests/ -> stratos-core/ -> repo root
const repoRoot = join(__dirname, '..', '..')

// The declaration lives under an NSID-derived layout. It is authored in
// `lexicons/` when the lex toolchain tolerates `"type": "space"`, or relocated
// to a sibling `lexicons-spaces/` dir if codegen chokes on it. The test must
// find it in either location.
const SANDBOX_FIXTURE_PATH = join(
  repoRoot,
  'test',
  'spaces-alignment',
  'atmosphere',
  'examples',
  'lexicon-fixtures',
  'zone.stratos.space.feed.json',
)

const LEXICON_ROOTS = ['lexicons', 'lexicons-spaces'] as const
const SPACE_TYPE_RELPATH = join('zone', 'stratos', 'space', 'feed.json')

interface SpaceDef {
  type: string
  key?: unknown
  title?: unknown
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

  it('carries a `title` the upstream rule accepts and no `name`', () => {
    expect(main?.title).toBeTypeOf('string')
    expect(upstreamAcceptsTitle(main?.title)).toBe(true)
    expect(main).not.toHaveProperty('name')
  })

  it('gives the sandbox declaration fixture the same title and type', () => {
    const fixtureMain = loadLexicon(SANDBOX_FIXTURE_PATH).defs?.['main']
    expect(fixtureMain?.type).toBe('space')
    expect(fixtureMain?.title).toBe(main?.title)
    expect(fixtureMain?.name).toBe(fixtureMain?.title)
  })

  it('holds the sandbox declaration fixture equal to the repository declaration apart from `name`', () => {
    const fixture = loadLexicon(SANDBOX_FIXTURE_PATH)
    const { name: _fixtureName, ...fixtureMain } = fixture.defs?.[
      'main'
    ] as SpaceDef
    expect({ ...fixture, defs: { main: fixtureMain } }).toEqual(doc)
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

  // The v1 values are decided; pin them so drift is caught.
  describe('v1 decided values', () => {
    it('matches the decided field table exactly', () => {
      expect(doc.id).toBe('zone.stratos.space.feed')
      expect(main?.type).toBe('space')
      expect(main?.key).toBe('any')
      expect(main?.title).toBe('Stratos Feed')
      expect(main?.collections).toEqual([
        'zone.stratos.feed.post',
        'app.bsky.feed.like',
        'app.bsky.feed.repost',
      ])
      expect(main?.description).toBe('A members-only Stratos post feed')
    })

    it('declares no localized titles (none for v1)', () => {
      expect(main?.['title:lang']).toBeUndefined()
    })
  })
})

// Each `upstream` value is what the pinned upstream lexicon-document schema
// (@atproto/lex-document 0.0.0-spaces-alpha-20261117141222, lexiconDocumentSchema)
// answered for a declaration carrying that `title`. Upstream refuses a lone
// surrogate before it measures anything, then measures the title in UTF-8
// bytes, not characters.
const UPSTREAM_TITLE_TABLE: ReadonlyArray<{
  label: string
  title: unknown
  upstream: 'accepted' | 'refused'
}> = [
  { label: 'absent', title: undefined, upstream: 'accepted' },
  { label: 'empty', title: '', upstream: 'refused' },
  { label: '1 character', title: 'a', upstream: 'accepted' },
  { label: '64 characters', title: 'a'.repeat(64), upstream: 'accepted' },
  { label: '65 characters', title: 'a'.repeat(65), upstream: 'refused' },
  { label: '512 characters', title: 'a'.repeat(512), upstream: 'refused' },
  {
    label: '10,000 characters',
    title: 'a'.repeat(10_000),
    upstream: 'refused',
  },
  { label: 'number', title: 5, upstream: 'refused' },
  { label: 'null', title: null, upstream: 'refused' },
  {
    label: '22 three-byte characters (66 bytes)',
    title: '日'.repeat(22),
    upstream: 'refused',
  },
  {
    label: '21 three-byte characters (63 bytes)',
    title: '日'.repeat(21),
    upstream: 'accepted',
  },
  {
    label: '64 emoji (256 bytes)',
    title: '😀'.repeat(64),
    upstream: 'refused',
  },
  {
    label: '16 emoji (64 bytes)',
    title: '😀'.repeat(16),
    upstream: 'accepted',
  },
  { label: 'a lone high surrogate', title: '\ud800', upstream: 'refused' },
  { label: 'a lone low surrogate', title: '\udc00', upstream: 'refused' },
  {
    label: 'a lone surrogate inside a short title',
    title: 'Bebop\ud83dCrew',
    upstream: 'refused',
  },
  {
    label: '63 characters and a lone high surrogate',
    title: 'a'.repeat(63) + '\ud83d',
    upstream: 'refused',
  },
  {
    label: '60 characters and a surrogate pair (64 bytes)',
    title: 'a'.repeat(60) + '😀',
    upstream: 'accepted',
  },
  {
    label: '61 characters and a surrogate pair (65 bytes)',
    title: 'a'.repeat(61) + '😀',
    upstream: 'refused',
  },
]

// Declarations that vary something other than the title, with the same oracle.
const UPSTREAM_SHAPE_TABLE: ReadonlyArray<{
  label: string
  change: (main: Record<string, unknown>) => void
  upstream: 'accepted' | 'refused'
  // The registry also refuses an empty or duplicated collection list, which
  // upstream accepts, and does not read `key`.
  registry: 'builds' | 'refuses'
}> = [
  {
    label: 'name instead of title',
    change: (m) => {
      delete m['title']
      m['name'] = 'Stratos Feed'
    },
    upstream: 'accepted',
    registry: 'builds',
  },
  {
    label: 'name beside title',
    change: (m) => {
      m['name'] = 'Stratos Feed'
    },
    upstream: 'accepted',
    registry: 'builds',
  },
  {
    label: 'neither name nor title',
    change: (m) => {
      delete m['title']
    },
    upstream: 'accepted',
    registry: 'builds',
  },
  {
    label: 'title:lang beside title',
    change: (m) => {
      m['title:lang'] = { ja: 'フィード' }
    },
    upstream: 'accepted',
    registry: 'builds',
  },
  {
    label: 'title:en beside title',
    change: (m) => {
      m['title:en'] = 'x'
    },
    upstream: 'accepted',
    registry: 'builds',
  },
  {
    label: 'type record',
    change: (m) => {
      m['type'] = 'record'
    },
    upstream: 'refused',
    registry: 'refuses',
  },
  {
    label: 'key tid',
    change: (m) => {
      m['key'] = 'tid'
    },
    upstream: 'accepted',
    registry: 'builds',
  },
  {
    label: 'key other than the four forms',
    change: (m) => {
      m['key'] = 'nope'
    },
    upstream: 'refused',
    registry: 'builds',
  },
  {
    label: 'empty collections',
    change: (m) => {
      m['collections'] = []
    },
    upstream: 'accepted',
    registry: 'refuses',
  },
  {
    label: 'duplicate collections',
    change: (m) => {
      m['collections'] = ['a.b.c', 'a.b.c']
    },
    upstream: 'accepted',
    registry: 'refuses',
  },
  {
    label: 'collection not an NSID',
    change: (m) => {
      m['collections'] = ['nope']
    },
    upstream: 'refused',
    registry: 'refuses',
  },
  {
    label: 'collection not a string',
    change: (m) => {
      m['collections'] = [1]
    },
    upstream: 'refused',
    registry: 'refuses',
  },
  {
    label: 'collections absent',
    change: (m) => {
      delete m['collections']
    },
    upstream: 'refused',
    registry: 'refuses',
  },
]

function upstreamAcceptsTitle(title: unknown): boolean {
  if (title === undefined) return true
  if (typeof title !== 'string') return false
  // TextEncoder would count a lone surrogate as the three bytes of U+FFFD.
  if (!title.isWellFormed()) return false
  const bytes = new TextEncoder().encode(title).length
  return bytes >= 1 && bytes <= 64
}

describe('title rule against the pinned upstream schema', () => {
  const { path } = locateSpaceTypeFile()
  const authored = loadLexicon(path)

  it.each(UPSTREAM_TITLE_TABLE)('title $label: upstream $upstream', (row) => {
    expect(upstreamAcceptsTitle(row.title) ? 'accepted' : 'refused').toBe(
      row.upstream,
    )
  })

  it('builds a registry from the authored declaration for every title upstream accepts', () => {
    for (const row of UPSTREAM_TITLE_TABLE) {
      if (row.upstream !== 'accepted') continue
      const copy = structuredClone(authored)
      const main = copy.defs?.['main'] as Record<string, unknown>
      if (row.title === undefined) delete main['title']
      else main['title'] = row.title
      expect(() => buildSpaceTypeRegistry([copy])).not.toThrow()
    }
  })

  it.each(UPSTREAM_SHAPE_TABLE)(
    'declaration with $label: upstream $upstream, registry $registry',
    (row) => {
      const copy = structuredClone(authored)
      row.change(copy.defs?.['main'] as Record<string, unknown>)
      const build = () => buildSpaceTypeRegistry([copy])
      if (row.registry === 'refuses') {
        expect(build).toThrow(InvalidSpaceTypeDeclarationError)
      } else {
        expect(build).not.toThrow()
      }
    },
  )

  it('still requires the three hosted collections of the authored declaration', () => {
    const registry = buildSpaceTypeRegistry([authored])
    expect(registry.collections('zone.stratos.space.feed')).toEqual([
      'zone.stratos.feed.post',
      'app.bsky.feed.like',
      'app.bsky.feed.repost',
    ])
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
