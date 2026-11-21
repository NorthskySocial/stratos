import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { computeCid, type RepoWrite } from '@northskysocial/stratos-core'
import {
  authorizeBoundary,
  authorizeRecordBoundary,
  extractRecordBoundary,
} from '../src/api/records/validation.js'
import {
  opBoundary,
  type RecordHandlerWrite,
} from '../src/api/records/types.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const PILOT = 'did:plc:asuka-langley'
const OTHER_SERVICE = 'did:web:seele.tokyo.jp'
const COLLECTION = 'zone.stratos.feed.post'

function recordClaiming(boundaries: string[]) {
  return {
    $type: COLLECTION,
    text: 'Sortie',
    createdAt: '1996-10-04T00:00:00.000Z',
    boundary: {
      $type: 'zone.stratos.boundary.defs#Domains',
      values: boundaries.map((value) => ({ value })),
    },
  }
}

async function errorNameOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work
    return null
  } catch (error) {
    return (error as { customErrorName?: string }).customErrorName ?? 'unnamed'
  }
}

describe('extractRecordBoundary', () => {
  it('returns the one boundary a record claims', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (boundary) => {
        expect(extractRecordBoundary(recordClaiming([boundary]))).toBe(boundary)
      }),
    )
  })

  it('rejects zero or several claimed boundaries with the count in the message', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.string({ minLength: 1 }), { maxLength: 6 })
          .filter((boundaries) => boundaries.length !== 1),
        (boundaries) => {
          expect(() =>
            extractRecordBoundary(recordClaiming(boundaries)),
          ).toThrow(
            `Records must target exactly one domain, received ${boundaries.length}`,
          )
        },
      ),
    )
  })

  it('rejects a record with no boundary field', () => {
    expect(() => extractRecordBoundary({ $type: COLLECTION })).toThrow(
      'received 0',
    )
  })
})

describe('authorizeBoundary', () => {
  let harness: WriteHarness

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(PILOT, [HARNESS_ENGINEERING, HARNESS_DESIGN])
  })

  afterAll(async () => {
    await harness.close()
  })

  const unheldName = fc
    .stringMatching(/^[a-z][a-z0-9-]{2,12}$/)
    .filter((name) => name !== 'engineering' && name !== 'design')
    .filter((name) => name !== 'general')
  const malformedName = fc.oneof(
    fc.constantFrom('.', '..'),
    fc.stringMatching(/^[a-z]{1,5} [a-z]{1,5}$/),
  )

  const cases = fc.oneof(
    fc.constantFrom(HARNESS_ENGINEERING, HARNESS_DESIGN).map((boundary) => ({
      boundary,
      expected: null,
    })),
    unheldName.map((name) => ({
      boundary: `${HARNESS_SERVICE_DID}/${name}`,
      expected: 'ForbiddenBoundary',
    })),
    unheldName.map((name) => ({
      boundary: `${OTHER_SERVICE}/${name}`,
      expected: 'ServiceMismatch',
    })),
    malformedName.chain((name) =>
      fc.constantFrom(HARNESS_SERVICE_DID, OTHER_SERVICE).map((service) => ({
        boundary: `${service}/${name}`,
        expected: 'InvalidDomain',
      })),
    ),
  )

  it('answers each boundary with the error of the first rule it breaks, and passes held ones through', async () => {
    await fc.assert(
      fc.asyncProperty(cases, async ({ boundary, expected }) => {
        const outcome = authorizeBoundary(harness.ctx, PILOT, boundary)
        expect(await errorNameOf(outcome)).toBe(expected)
        if (expected === null) expect(await outcome).toBe(boundary)
      }),
      { numRuns: 60 },
    )
  })

  it('composes with the record extraction under the same errors', async () => {
    await fc.assert(
      fc.asyncProperty(cases, async ({ boundary, expected }) => {
        const outcome = authorizeRecordBoundary(
          harness.ctx,
          PILOT,
          COLLECTION,
          recordClaiming([boundary]),
        )
        expect(await errorNameOf(outcome)).toBe(expected)
      }),
      { numRuns: 30 },
    )
    expect(
      await errorNameOf(
        authorizeRecordBoundary(
          harness.ctx,
          PILOT,
          COLLECTION,
          recordClaiming([HARNESS_ENGINEERING, HARNESS_DESIGN]),
        ),
      ),
    ).toBe('InvalidDomainCount')
  })
})

describe('opBoundary', () => {
  it('wraps one boundary in the op-level value set', () => {
    fc.assert(
      fc.property(fc.string(), (boundary) => {
        expect(opBoundary(boundary)).toEqual({ values: [{ value: boundary }] })
      }),
    )
  })
})

describe('record handler writes', () => {
  it('require a boundary on create and update and none on delete, and fit the core write type', async () => {
    const cid = await computeCid(recordClaiming([HARNESS_ENGINEERING]))

    // @ts-expect-error a create write without a boundary must not compile
    const createWithoutBoundary: RecordHandlerWrite = {
      action: 'create',
      collection: COLLECTION,
      rkey: 'unit-01',
      record: {},
      cid,
    }
    // @ts-expect-error an update write without a boundary must not compile
    const updateWithoutBoundary: RecordHandlerWrite = {
      action: 'update',
      collection: COLLECTION,
      rkey: 'unit-01',
      record: {},
      cid,
    }
    const deleteWithBoundary: RecordHandlerWrite = {
      action: 'delete',
      collection: COLLECTION,
      rkey: 'unit-01',
      // @ts-expect-error a delete write carries no boundary
      boundary: HARNESS_ENGINEERING,
    }
    expect([
      createWithoutBoundary.action,
      updateWithoutBoundary.action,
      deleteWithBoundary.action,
    ]).toEqual(['create', 'update', 'delete'])

    const bounded: RecordHandlerWrite[] = [
      {
        action: 'create',
        collection: COLLECTION,
        rkey: 'unit-01',
        record: {},
        cid,
        boundary: HARNESS_ENGINEERING,
      },
      { action: 'delete', collection: COLLECTION, rkey: 'unit-01' },
    ]
    const forManager: RepoWrite[] = bounded
    expect(forManager).toHaveLength(2)
  })
})
