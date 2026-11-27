import { StratosError } from '../shared/errors.js'
import { isValidNsidStr } from './domain.js'

export class InvalidSpaceTypeDeclarationError extends StratosError {
  constructor(message: string) {
    super(message, 'InvalidSpaceTypeDeclaration')
    this.name = 'InvalidSpaceTypeDeclarationError'
  }
}

export interface SpaceTypeRegistry {
  collections: (type: string) => readonly string[] | undefined
  allowsCollection: (type: string, collection: string) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeDeclaration(entry: unknown, index: number): string {
  const id = isRecord(entry) ? entry['id'] : undefined
  return typeof id === 'string' && id.length > 0
    ? `"${id}"`
    : `at index ${index}`
}

function readCollections(
  entry: Record<string, unknown>,
  label: string,
): readonly string[] {
  const defs = entry['defs']
  const main = isRecord(defs) ? defs['main'] : undefined
  if (!isRecord(main) || main['type'] !== 'space') {
    throw new InvalidSpaceTypeDeclarationError(
      `Space type declaration ${label} must have defs.main.type "space"`,
    )
  }
  const collections = main['collections']
  if (!Array.isArray(collections) || collections.length === 0) {
    throw new InvalidSpaceTypeDeclarationError(
      `Space type declaration ${label} must list a non-empty collections array`,
    )
  }
  const seen = new Set<string>()
  for (const collection of collections) {
    if (typeof collection !== 'string' || !isValidNsidStr(collection)) {
      throw new InvalidSpaceTypeDeclarationError(
        `Space type declaration ${label} lists an invalid collection NSID`,
      )
    }
    if (seen.has(collection)) {
      throw new InvalidSpaceTypeDeclarationError(
        `Space type declaration ${label} lists collection "${collection}" twice`,
      )
    }
    seen.add(collection)
  }
  return Object.freeze([...seen])
}

export function buildSpaceTypeRegistry(
  declarations: readonly unknown[],
): SpaceTypeRegistry {
  if (declarations.length === 0) {
    throw new InvalidSpaceTypeDeclarationError(
      'At least one space type declaration is required',
    )
  }
  const byType = new Map<string, readonly string[]>()
  declarations.forEach((entry, index) => {
    const label = describeDeclaration(entry, index)
    if (!isRecord(entry)) {
      throw new InvalidSpaceTypeDeclarationError(
        `Space type declaration ${label} must be an object`,
      )
    }
    if (entry['lexicon'] !== 1) {
      throw new InvalidSpaceTypeDeclarationError(
        `Space type declaration ${label} must have lexicon version 1`,
      )
    }
    const id = entry['id']
    if (typeof id !== 'string' || !isValidNsidStr(id)) {
      throw new InvalidSpaceTypeDeclarationError(
        `Space type declaration ${label} has an invalid id`,
      )
    }
    if (byType.has(id)) {
      throw new InvalidSpaceTypeDeclarationError(
        `Space type declaration ${label} is declared more than once`,
      )
    }
    byType.set(id, readCollections(entry, label))
  })
  return {
    collections: (type) => byType.get(type),
    allowsCollection: (type, collection) =>
      byType.get(type)?.includes(collection) ?? false,
  }
}

export function requireSpaceTypeCollections(
  registry: SpaceTypeRegistry,
  type: string,
): readonly string[] {
  const collections = registry.collections(type)
  if (collections === undefined) {
    throw new InvalidSpaceTypeDeclarationError(
      `Space type "${type}" is missing from the registry`,
    )
  }
  return collections
}
