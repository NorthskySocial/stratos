import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { StratosValidator } from '../src/index.js'
import type { StratosConfig } from '../src/index.js'
import { StratosValidator as ReferenceValidator } from './fixtures/stratos-validation.0e153eae.reference.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const REFERENCE_BODY_SHA256 =
  'ebfa013be7621190fed1b87e4cae29c0c6225a46f4a5ef8de2d3a866dcaf1b5a'
const REFERENCE_MARKER = '// --- reference body ---\n'
const RUNS = 20_000

const enabledConfig: StratosConfig = {
  serviceDid: SERVICE_DID,
  allowedDomains: [`${SERVICE_DID}/engineering`, 'design'],
  retentionDays: 90,
}
const disabledConfig: StratosConfig = { ...enabledConfig, allowedDomains: [] }

const domainValue = fc.oneof(
  fc.constantFrom(
    `${SERVICE_DID}/engineering`,
    'engineering',
    'design',
    `${SERVICE_DID}/design`,
    'leadership',
    'did:web:seele.example/engineering',
    '',
  ),
  fc.string(),
)
const validEntry = fc.constantFrom(
  { value: `${SERVICE_DID}/engineering` },
  { value: 'design' },
)
const rejectedEntry = fc.oneof(
  fc.record({ value: fc.constantFrom('leadership', 'did:web:x/y', '') }),
  fc.record({ value: domainValue }),
)
const strangeEntry = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant({}),
  fc.record({ other: fc.string() }),
  fc.record({ value: fc.oneof(fc.integer(), fc.constant(null), fc.boolean()) }),
  fc.record({ value: fc.constant(['a']) }),
)
const entries = fc.array(fc.oneof(validEntry, rejectedEntry, strangeEntry), {
  maxLength: 5,
})
const values = fc.oneof(
  entries,
  fc.constant(undefined),
  fc.integer(),
  fc.string(),
  fc.constant(null),
  fc.constant({ value: 'design' }),
  fc.constant(true),
)
const claim = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.array(fc.string(), { maxLength: 2 }),
  fc.record({ values }),
  fc.record({ $type: fc.string(), values }),
  fc.record({ $type: fc.string() }),
  fc.constant({}),
)

const stratosUri = 'at://did:plc:rei/zone.stratos.feed.post/eva00'
const bskyUri = 'at://did:plc:rei/app.bsky.feed.post/eva00'
const uri = fc.constantFrom(stratosUri, bskyUri, 'not-a-uri', '')
const reply = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.record({ parent: fc.record({ uri }), root: fc.record({ uri }) }),
  fc.record({ parent: fc.record({ uri }) }),
  fc.constant({}),
)
const embed = fc.oneof(
  fc.constant(undefined),
  fc.string(),
  fc.record({ record: fc.record({ uri }) }),
  fc.record({ media: fc.record({ record: fc.record({ uri }) }) }),
  fc.record({ media: fc.constant('x') }),
)
const record = fc
  .record({ boundary: claim, reply, embed }, { requiredKeys: [] })
  .map((fields) => ({ text: 'Sortie', ...fields }))
const parentBoundaries = fc.oneof(
  fc.constant(undefined),
  fc.array(domainValue, { maxLength: 3 }),
)
const collection = fc.constantFrom(
  'zone.stratos.feed.post',
  'zone.stratos.actor.enrollment',
  'zone.stratos.feed.like',
  'app.bsky.feed.post',
)

interface Outcome {
  result: string
}

function outcomeOf(run: () => unknown): Outcome {
  try {
    return { result: `returned ${JSON.stringify(run())}` }
  } catch (error) {
    const thrown = error as { name: string; code?: string; message: string }
    return { result: `${thrown.name}|${thrown.code}|${thrown.message}` }
  }
}

describe('StratosValidator against the frozen reference', () => {
  it('keeps the reference body byte-identical to 0e153eae', () => {
    const source = readFileSync(
      new URL(
        './fixtures/stratos-validation.0e153eae.reference.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const body = source.slice(
      source.indexOf(REFERENCE_MARKER) + REFERENCE_MARKER.length,
    )

    expect(createHash('sha256').update(body).digest('hex')).toBe(
      REFERENCE_BODY_SHA256,
    )
  })

  describe.each([
    ['an enabled service', enabledConfig],
    ['a service with no allowed domains', disabledConfig],
  ])('on %s', (_label, config) => {
    it('accepts, rejects and throws exactly as the reference does', () => {
      const current = new StratosValidator(config)
      const reference = new ReferenceValidator(config)

      fc.assert(
        fc.property(
          record,
          collection,
          parentBoundaries,
          (rec, col, parents) => {
            expect(
              outcomeOf(() => current.assertValid(rec, col, parents)),
            ).toEqual(outcomeOf(() => reference.assertValid(rec, col, parents)))
          },
        ),
        { numRuns: RUNS },
      )
    })
  })
})
