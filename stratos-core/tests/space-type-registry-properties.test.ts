import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { isValidNsidStr } from '../src/spaces/domain.js'
import {
  buildSpaceTypeRegistry,
  InvalidSpaceTypeDeclarationError,
} from '../src/spaces/space-type-registry.js'

const lowerSegment = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/)
const nameSegment = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/)

const nsid = fc
  .tuple(lowerSegment, lowerSegment, nameSegment)
  .map(([authority, group, name]) => `${authority}.${group}.${name}`)

interface Declared {
  id: string
  collections: string[]
}

const declared = fc.record({
  id: nsid,
  collections: fc.uniqueArray(nsid, { minLength: 1, maxLength: 4 }),
})

function declaredList(minLength: number) {
  return fc.uniqueArray(declared, {
    minLength,
    maxLength: 5,
    selector: (entry) => entry.id,
  })
}

function toDeclaration(entry: Declared) {
  return {
    lexicon: 1,
    id: entry.id,
    defs: { main: { type: 'space', collections: [...entry.collections] } },
  }
}

type Declaration = ReturnType<typeof toDeclaration>

type Corrupt = (declaration: Declaration, sibling: Declaration) => void

const NOT_NSIDS: readonly unknown[] = ['lilith', '', 'not an nsid', 7, null]

const corruptions: Record<string, fc.Arbitrary<Corrupt>> = {
  lexicon: fc
    .oneof(
      fc.integer().filter((n) => n !== 1),
      fc.constant('1'),
    )
    .map((value) => (d) => {
      ;(d as { lexicon: unknown }).lexicon = value
    }),
  id: fc.constantFrom(...NOT_NSIDS).map((value) => (d) => {
    ;(d as { id: unknown }).id = value
  }),
  mainType: fc.constantFrom('record', 'query', '', 7).map((value) => (d) => {
    ;(d.defs.main as { type: unknown }).type = value
  }),
  collectionsNotNonEmptyArray: fc
    .constantFrom<unknown>([], 'zone.stratos.record.eva', null, {})
    .map((value) => (d) => {
      ;(d.defs.main as { collections: unknown }).collections = value
    }),
  collectionNotNsid: fc
    .tuple(fc.constantFrom(...NOT_NSIDS), fc.nat())
    .map(([value, slot]) => (d) => {
      const list = d.defs.main.collections as unknown[]
      list.splice(slot % (list.length + 1), 0, value)
    }),
  duplicateCollection: fc.constant<Corrupt>((d) => {
    d.defs.main.collections.push(d.defs.main.collections[0] as string)
  }),
  duplicateId: fc.constant<Corrupt>((d, sibling) => {
    d.id = sibling.id
  }),
}

describe('space type registry properties', () => {
  it('generates only valid NSIDs', () => {
    fc.assert(fc.property(nsid, (value) => isValidNsidStr(value)))
  })

  it('P1: exposes each declaration in input order and allows its collections', () => {
    fc.assert(
      fc.property(declaredList(1), (entries) => {
        const registry = buildSpaceTypeRegistry(entries.map(toDeclaration))
        for (const entry of entries) {
          expect(registry.collections(entry.id)).toEqual(entry.collections)
          for (const collection of entry.collections) {
            expect(registry.allowsCollection(entry.id, collection)).toBe(true)
          }
        }
      }),
    )
  })

  it('P2: rejects undeclared types and unlisted collections', () => {
    fc.assert(
      fc.property(declaredList(1), nsid, nsid, (entries, other, stray) => {
        const registry = buildSpaceTypeRegistry(entries.map(toDeclaration))
        fc.pre(!entries.some((entry) => entry.id === other))
        expect(registry.collections(other)).toBeUndefined()
        for (const entry of entries) {
          expect(registry.allowsCollection(other, entry.collections[0]!)).toBe(
            false,
          )
          fc.pre(!entry.collections.includes(stray))
          expect(registry.allowsCollection(entry.id, stray)).toBe(false)
        }
      }),
    )
  })

  it('P3: is independent of declaration order', () => {
    const shuffled = declaredList(1).chain((entries) =>
      fc
        .shuffledSubarray(entries, {
          minLength: entries.length,
          maxLength: entries.length,
        })
        .map((reordered) => ({ entries, reordered })),
    )
    fc.assert(
      fc.property(shuffled, ({ entries, reordered }) => {
        const original = buildSpaceTypeRegistry(entries.map(toDeclaration))
        const permuted = buildSpaceTypeRegistry(reordered.map(toDeclaration))
        for (const entry of entries) {
          expect(permuted.collections(entry.id)).toEqual(
            original.collections(entry.id),
          )
        }
      }),
    )
  })

  describe('P4: one corrupted field makes the build throw', () => {
    for (const [name, corruption] of Object.entries(corruptions)) {
      it(name, () => {
        const scenario = fc.tuple(declaredList(2), fc.nat(), corruption)
        fc.assert(
          fc.property(scenario, ([entries, slot, corrupt]) => {
            const declarations = entries.map(toDeclaration)
            const index = slot % declarations.length
            const sibling = declarations[(index + 1) % declarations.length]!
            corrupt(declarations[index]!, sibling)
            expect(() => buildSpaceTypeRegistry(declarations)).toThrow(
              InvalidSpaceTypeDeclarationError,
            )
          }),
        )
      })
    }
  })
})
