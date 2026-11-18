import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSpaceTypeRegistry,
  InvalidSpaceTypeDeclarationError,
  requireSpaceTypeCollections,
} from '../src/spaces/space-type-registry.js'

const TOKYO3 = 'zone.stratos.space.tokyo3'
const NERV = 'zone.stratos.space.nerv'
const EVA = 'zone.stratos.record.eva'
const ANGEL = 'zone.stratos.record.angel'

function declaration(
  id: string,
  collections: unknown = [EVA],
  overrides: Record<string, unknown> = {},
) {
  return {
    lexicon: 1,
    id,
    defs: { main: { type: 'space', collections } },
    ...overrides,
  }
}

function expectInvalid(input: readonly unknown[], ...messageParts: string[]) {
  let thrown: unknown
  try {
    buildSpaceTypeRegistry(input)
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(InvalidSpaceTypeDeclarationError)
  const error = thrown as InvalidSpaceTypeDeclarationError
  expect(error.name).toBe('InvalidSpaceTypeDeclarationError')
  expect(error.code).toBe('InvalidSpaceTypeDeclaration')
  for (const part of messageParts) expect(error.message).toContain(part)
}

describe('buildSpaceTypeRegistry', () => {
  it('maps a single declaration to its collections', () => {
    const registry = buildSpaceTypeRegistry([declaration(TOKYO3, [EVA, ANGEL])])
    expect(registry.collections(TOKYO3)).toEqual([EVA, ANGEL])
  })

  it('maps two declarations independently', () => {
    const registry = buildSpaceTypeRegistry([
      declaration(TOKYO3, [EVA]),
      declaration(NERV, [ANGEL]),
    ])
    expect(registry.collections(TOKYO3)).toEqual([EVA])
    expect(registry.collections(NERV)).toEqual([ANGEL])
  })

  it('returns undefined collections for an unknown type', () => {
    const registry = buildSpaceTypeRegistry([declaration(TOKYO3)])
    expect(registry.collections(NERV)).toBeUndefined()
  })

  it('exposes frozen collection lists', () => {
    const registry = buildSpaceTypeRegistry([declaration(TOKYO3)])
    expect(Object.isFrozen(registry.collections(TOKYO3))).toBe(true)
  })

  it('does not change when the input is mutated afterwards', () => {
    const collections = [EVA]
    const registry = buildSpaceTypeRegistry([declaration(TOKYO3, collections)])
    collections.push(ANGEL)
    expect(registry.collections(TOKYO3)).toEqual([EVA])
  })

  describe('allowsCollection', () => {
    const build = () => buildSpaceTypeRegistry([declaration(TOKYO3, [EVA])])

    it('is true for a listed collection', () => {
      const registry = build()
      expect(registry.allowsCollection(TOKYO3, EVA)).toBe(true)
    })

    it('is false for an unlisted collection', () => {
      const registry = build()
      expect(registry.allowsCollection(TOKYO3, ANGEL)).toBe(false)
    })

    it('is false for an unknown type', () => {
      const registry = build()
      expect(registry.allowsCollection(NERV, EVA)).toBe(false)
    })
  })

  describe('malformed input', () => {
    it('rejects an empty array', () => {
      expectInvalid([], 'At least one space type declaration is required')
    })

    it('rejects a non-object entry', () => {
      expectInvalid(['shinji'], 'index 0', 'must be an object')
      expectInvalid([null], 'must be an object')
      expectInvalid([[declaration(TOKYO3)]], 'must be an object')
    })

    it('rejects a lexicon version other than 1', () => {
      expectInvalid(
        [declaration(TOKYO3, [EVA], { lexicon: 2 })],
        TOKYO3,
        'lexicon version 1',
      )
    })

    it('rejects an invalid id and names the entry by index', () => {
      expectInvalid([declaration('not an nsid')], 'not an nsid', 'invalid id')
      expectInvalid(
        [declaration(TOKYO3), declaration('')],
        'index 1',
        'invalid id',
      )
      expectInvalid(
        [declaration(TOKYO3, [EVA], { id: 42 })],
        'index 0',
        'invalid id',
      )
    })

    it('rejects a main def that is not a space', () => {
      expectInvalid(
        [
          {
            lexicon: 1,
            id: TOKYO3,
            defs: { main: { type: 'record', collections: [EVA] } },
          },
        ],
        TOKYO3,
        'defs.main.type "space"',
      )
      expectInvalid(
        [{ lexicon: 1, id: TOKYO3, defs: {} }],
        TOKYO3,
        'defs.main.type "space"',
      )
      expectInvalid(
        [{ lexicon: 1, id: TOKYO3 }],
        TOKYO3,
        'defs.main.type "space"',
      )
    })

    it('rejects collections that are not a non-empty array', () => {
      expectInvalid(
        [declaration(TOKYO3, [])],
        TOKYO3,
        'non-empty collections array',
      )
      expectInvalid(
        [declaration(TOKYO3, EVA)],
        TOKYO3,
        'non-empty collections array',
      )
      expectInvalid(
        [declaration(TOKYO3, null)],
        TOKYO3,
        'non-empty collections array',
      )
    })

    it('rejects collections that are not valid NSIDs', () => {
      expectInvalid(
        [declaration(TOKYO3, ['lilith'])],
        TOKYO3,
        'invalid collection NSID',
      )
      expectInvalid(
        [declaration(TOKYO3, [EVA, 7])],
        TOKYO3,
        'invalid collection NSID',
      )
    })

    it('rejects a collection listed twice in one declaration', () => {
      expectInvalid([declaration(TOKYO3, [EVA, EVA])], EVA, 'twice')
    })

    it('rejects two declarations sharing an id', () => {
      expectInvalid(
        [declaration(TOKYO3), declaration(TOKYO3, [ANGEL])],
        TOKYO3,
        'more than once',
      )
    })
  })

  describe('requireSpaceTypeCollections', () => {
    it('returns the collections of a declared type', () => {
      const registry = buildSpaceTypeRegistry([
        declaration(TOKYO3, [EVA, ANGEL]),
      ])
      expect(requireSpaceTypeCollections(registry, TOKYO3)).toEqual([
        EVA,
        ANGEL,
      ])
    })

    it('throws for a type missing from the registry', () => {
      const registry = buildSpaceTypeRegistry([declaration(TOKYO3)])
      let thrown: unknown
      try {
        requireSpaceTypeCollections(registry, NERV)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(InvalidSpaceTypeDeclarationError)
      const error = thrown as InvalidSpaceTypeDeclarationError
      expect(error.code).toBe('InvalidSpaceTypeDeclaration')
      expect(error.message).toBe(
        `Space type "${NERV}" is missing from the registry`,
      )
    })
  })

  it('loads the shipped feed space type declaration', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const feedPath = join(
      here,
      '..',
      '..',
      'lexicons-spaces',
      'zone',
      'stratos',
      'space',
      'feed.json',
    )
    const feed: unknown = JSON.parse(readFileSync(feedPath, 'utf-8'))
    const registry = buildSpaceTypeRegistry([feed])
    expect(registry.collections('zone.stratos.space.feed')).toEqual([
      'zone.stratos.feed.post',
      'app.bsky.feed.like',
      'app.bsky.feed.repost',
    ])
  })
})
