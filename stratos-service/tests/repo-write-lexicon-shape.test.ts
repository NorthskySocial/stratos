import { readFileSync } from 'node:fs'
import { Lexicons, ValidationError } from '@atproto/lexicon'
import { DefaultLexiconProvider } from '@northskysocial/stratos-core'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

interface ShapeProperty {
  type: string
  format?: string
  maxLength?: number
  minLength?: number
  knownValues?: string[]
  items?: { type: string; refs?: string[]; closed?: boolean }
}

interface ShapeObject {
  required: string[]
  properties: Record<string, ShapeProperty>
}

interface ReferenceProcedure {
  input: ShapeObject
  output: ShapeObject
  errors: string[]
  defs: Record<string, ShapeObject>
}

interface ReferenceShapes {
  referenceCommit: string
  writesLengthLimit: {
    declaredInReferenceLexicon: boolean
    referenceImplementation: { limit: number; file: string }
  }
  procedures: Record<string, ReferenceProcedure>
}

interface LexiconDefinition {
  type?: string
  description?: string
  input?: { schema: ShapeObject }
  output?: { schema: ShapeObject }
  errors?: Array<{ name: string; description?: string }>
}

interface LexiconDocument {
  id: string
  defs: Record<string, LexiconDefinition & Partial<ShapeObject>>
}

const FIXTURE_URL = new URL(
  './fixtures/reference-space-write-shapes.json',
  import.meta.url,
)
const reference = JSON.parse(
  readFileSync(FIXTURE_URL, 'utf8'),
) as ReferenceShapes

const PROCEDURES = [
  'createRecord',
  'putRecord',
  'deleteRecord',
  'applyWrites',
] as const
const REFERENCE_PREFIX = 'com.atproto.space.'
const lexiconId = (name: string) => `zone.stratos.repo.${name}`

/** Every place where the Stratos lexicons differ from the reference ones. */
const DECLARED_DIFFERENCES = {
  boundaryProperty: {
    name: 'boundary',
    shape: { type: 'string', maxLength: 253 } satisfies ShapeProperty,
  },
  writesLength: { minLength: 1, maxLength: 200 },
  renamedErrors: { SpaceNotFound: 'BoundaryNotFound' } as Record<
    string,
    string
  >,
  addedErrors: [
    'InvalidCollection',
    'NotEnrolled',
    'ServiceWriteForbidden',
    'PdsCustodyWriteForbidden',
    'ForbiddenBoundary',
    'InvalidDomain',
    'ServiceMismatch',
    'RateLimitExceeded',
  ],
  // A delete holds no record body, so it can neither disagree with the
  // boundary nor break a content rule.
  addedErrorsByProcedure: {
    createRecord: ['BoundaryMismatch', 'InvalidRecord', 'ScopeUpgradeRequired'],
    putRecord: [
      'RecordAlreadyExists',
      'BoundaryMismatch',
      'InvalidRecord',
      'ScopeUpgradeRequired',
    ],
    applyWrites: ['BoundaryMismatch', 'InvalidRecord', 'ScopeUpgradeRequired'],
  } as Record<string, string[]>,
}

const provider = new DefaultLexiconProvider()
const lexicons = new Lexicons(provider.getAll())

function documentOf(name: string): LexiconDocument {
  const doc = provider.get(lexiconId(name))
  if (!doc) throw new Error(`${lexiconId(name)} is not registered`)
  return doc as unknown as LexiconDocument
}

function inputOf(name: string): ShapeObject {
  const schema = documentOf(name).defs.main.input?.schema
  if (!schema) throw new Error(`${name} has no input`)
  return schema
}

function outputOf(name: string): ShapeObject {
  const schema = documentOf(name).defs.main.output?.schema
  if (!schema) throw new Error(`${name} has no output`)
  return schema
}

/** A lexicon registry may expand `#create` to `lex:{id}#create`. */
const localRef = (ref: string) => ref.replace(/^lex:[^#]+/, '')

function shapeOf(property: ShapeProperty): ShapeProperty {
  const shape: ShapeProperty = { type: property.type }
  if (property.format !== undefined) shape.format = property.format
  if (property.maxLength !== undefined) shape.maxLength = property.maxLength
  if (property.minLength !== undefined) shape.minLength = property.minLength
  if (property.knownValues !== undefined) {
    shape.knownValues = property.knownValues
  }
  if (property.items) {
    shape.items = { type: property.items.type }
    if (property.items.refs) {
      shape.items.refs = property.items.refs.map(localRef)
    }
    if (property.items.closed !== undefined) {
      shape.items.closed = property.items.closed
    }
  }
  return shape
}

function shapesOf(object: ShapeObject): Record<string, ShapeProperty> {
  return Object.fromEntries(
    Object.entries(object.properties ?? {}).map(([name, property]) => [
      name,
      shapeOf(property),
    ]),
  )
}

function expectedInputShapes(name: string): Record<string, ShapeProperty> {
  const { space: _omitted, ...kept } = shapesOf(
    reference.procedures[name].input,
  )
  const expected: Record<string, ShapeProperty> = {
    [DECLARED_DIFFERENCES.boundaryProperty.name]:
      DECLARED_DIFFERENCES.boundaryProperty.shape,
    ...kept,
  }
  if (name === 'applyWrites') {
    expected.writes = {
      ...expected.writes,
      ...DECLARED_DIFFERENCES.writesLength,
    }
  }
  return expected
}

function expectedErrors(name: string): string[] {
  return [
    ...reference.procedures[name].errors.map(
      (error) => DECLARED_DIFFERENCES.renamedErrors[error] ?? error,
    ),
    ...DECLARED_DIFFERENCES.addedErrors,
    ...(DECLARED_DIFFERENCES.addedErrorsByProcedure[name] ?? []),
  ]
}

describe('repo write lexicons against the reference field lists', () => {
  it('records where the reference limits the batch size', () => {
    expect(reference.referenceCommit).toBe('98ef3a6b9')
    expect(reference.writesLengthLimit.declaredInReferenceLexicon).toBe(false)
    expect(reference.writesLengthLimit.referenceImplementation.limit).toBe(
      DECLARED_DIFFERENCES.writesLength.maxLength,
    )
  })

  describe.each(PROCEDURES)('%s', (name) => {
    it('is a procedure whose description names the reference procedure and commit', () => {
      const main = documentOf(name).defs.main
      expect(main.type).toBe('procedure')
      expect(main.description).toContain(`${REFERENCE_PREFIX}${name}`)
      expect(main.description).toContain(reference.referenceCommit)
    })

    it('takes the reference input with the boundary in place of the reference container', () => {
      const input = inputOf(name)
      expect(input.properties).toBeDefined()
      expect(shapesOf(input)).toEqual(expectedInputShapes(name))
      const referenceRequired = reference.procedures[name].input.required.map(
        (field) => (field === 'space' ? 'boundary' : field),
      )
      expect([...input.required].sort()).toEqual([...referenceRequired].sort())
    })

    it('returns exactly the reference output', () => {
      const output = outputOf(name)
      expect(shapesOf(output)).toEqual(
        shapesOf(reference.procedures[name].output),
      )
      expect([...(output.required ?? [])].sort()).toEqual(
        [...reference.procedures[name].output.required].sort(),
      )
    })

    it('declares the reference errors renamed for boundaries, plus the Stratos errors', () => {
      const names = (documentOf(name).defs.main.errors ?? []).map(
        (error) => error.name,
      )
      expect([...names].sort()).toEqual([...expectedErrors(name)].sort())
    })

    it('defines the same local definitions as the reference, field for field', () => {
      const doc = documentOf(name)
      const localDefs = Object.keys(doc.defs).filter((key) => key !== 'main')
      expect(localDefs.sort()).toEqual(
        Object.keys(reference.procedures[name].defs).sort(),
      )
      for (const [key, expected] of Object.entries(
        reference.procedures[name].defs,
      )) {
        const actual = doc.defs[key] as unknown as ShapeObject
        expect(shapesOf(actual)).toEqual(shapesOf(expected))
        expect([...(actual.required ?? [])].sort()).toEqual(
          [...expected.required].sort(),
        )
      }
    })

    it('names no space anywhere outside the reference procedure id', () => {
      const text = JSON.stringify(documentOf(name)).replaceAll(
        `${REFERENCE_PREFIX}${name}`,
        '',
      )
      expect(text).not.toMatch(/space/i)
    })

    it('requires the boundary', () => {
      expect(inputOf(name).required).toContain('boundary')
    })
  })

  it('bounds one batch to the length the reference implementation enforces', () => {
    const writes = inputOf('applyWrites').properties.writes
    expect(writes.minLength).toBe(1)
    expect(writes.maxLength).toBe(200)
    expect(shapeOf(writes).items).toEqual({
      type: 'union',
      refs: ['#create', '#update', '#delete'],
      closed: true,
    })
  })

  it('registers all four lexicons in the default provider', () => {
    const ids = new DefaultLexiconProvider().getAll().map((doc) => doc.id)
    for (const name of PROCEDURES) expect(ids).toContain(lexiconId(name))
  })
})

describe('repo write lexicons input limits', () => {
  const REPO = 'did:plc:rei-ayanami'
  const COLLECTION = 'zone.stratos.feed.post'
  const record = {
    $type: COLLECTION,
    text: 'Sortie',
    createdAt: '1996-10-04T00:00:00.000Z',
  }
  const createInput = (boundary: string) => ({
    boundary,
    repo: REPO,
    collection: COLLECTION,
    record,
  })
  const writesOfLength = (count: number) => ({
    boundary: 'did:web:nerv.tokyo.jp/engineering',
    repo: REPO,
    writes: Array.from({ length: count }, (_, index) => ({
      $type: `${lexiconId('applyWrites')}#create`,
      collection: COLLECTION,
      rkey: `unit-${index}`,
      value: record,
    })),
  })
  const accepts = (name: string, body: unknown) => {
    try {
      lexicons.assertValidXrpcInput(lexiconId(name), body)
      return true
    } catch (error) {
      if (error instanceof ValidationError) return false
      throw error
    }
  }
  const asciiOfLength = (minLength: number, maxLength: number) =>
    fc.string({ unit: 'grapheme-ascii', minLength, maxLength })

  it('accepts a qualified boundary of 1 to 253 characters', () => {
    fc.assert(
      fc.property(asciiOfLength(1, 253), (boundary) =>
        accepts('createRecord', createInput(boundary)),
      ),
    )
  })

  it('rejects a boundary longer than 253 characters', () => {
    fc.assert(
      fc.property(
        asciiOfLength(254, 400),
        (boundary) => !accepts('createRecord', createInput(boundary)),
      ),
    )
  })

  it('accepts 1 to 200 writes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (count) =>
        accepts('applyWrites', writesOfLength(count)),
      ),
      { numRuns: 25 },
    )
  })

  it('rejects no writes and more than 200 writes', () => {
    expect(accepts('applyWrites', writesOfLength(0))).toBe(false)
    fc.assert(
      fc.property(
        fc.integer({ min: 201, max: 260 }),
        (count) => !accepts('applyWrites', writesOfLength(count)),
      ),
      { numRuns: 25 },
    )
  })

  it('rejects a createRecord input with no boundary', () => {
    expect(
      accepts('createRecord', { repo: REPO, collection: COLLECTION, record }),
    ).toBe(false)
  })
})
