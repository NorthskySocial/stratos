import { beforeEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  RECORD_RULE_BUILDERS,
  StratosValidationError,
  StratosValidator,
  buildRecordRules,
  findRecordRule,
} from '../src/index.js'
import type { StratosConfig } from '../src/index.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const ENGINEERING = `${SERVICE_DID}/engineering`
const POST = 'zone.stratos.feed.post'
const ENROLLMENT = 'zone.stratos.actor.enrollment'

const enabledConfig: StratosConfig = {
  serviceDid: SERVICE_DID,
  allowedDomains: [ENGINEERING],
  retentionDays: 90,
}
const disabledConfig: StratosConfig = { ...enabledConfig, allowedDomains: [] }

let rules: ReturnType<typeof buildRecordRules>

beforeEach(() => {
  rules = buildRecordRules(enabledConfig)
})

const nsidSegment = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/)
const nsid = fc
  .tuple(
    fc.array(nsidSegment, { minLength: 2, maxLength: 3 }),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,11}$/),
  )
  .map(([authority, name]) => `${authority.join('.')}.${name}`)
const registered = [POST, ENROLLMENT]
const unregisteredStratos = nsid
  .map((name) => `zone.stratos.${name}`)
  .filter((collection) => !registered.includes(collection))
const otherNamespace = nsid.filter(
  (collection) => !collection.startsWith('zone.stratos.'),
)

function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('record rule registry lookup', () => {
  it('gives a registered collection its own rule', () => {
    fc.assert(
      fc.property(fc.constantFrom(...registered), (collection) => {
        expect(findRecordRule(rules, collection)?.collection).toBe(collection)
      }),
    )
  })

  it('gives an unregistered zone.stratos collection no rule', () => {
    fc.assert(
      fc.property(unregisteredStratos, (collection) => {
        expect(findRecordRule(rules, collection)).toBeUndefined()
      }),
    )
  })

  it('gives any other collection no rule', () => {
    fc.assert(
      fc.property(otherNamespace, (collection) => {
        expect(findRecordRule(rules, collection)).toBeUndefined()
      }),
    )
  })

  it('builds one rule per builder, each under its own collection', () => {
    expect(rules.size).toBe(RECORD_RULE_BUILDERS.length)
    for (const [collection, rule] of rules) {
      expect(rule.collection).toBe(collection)
    }
  })
})

describe('assertValid dispatch through the registry', () => {
  let enabled: StratosValidator
  let disabled: StratosValidator

  beforeEach(() => {
    enabled = new StratosValidator(enabledConfig)
    disabled = new StratosValidator(disabledConfig)
  })

  const unboundedRecord = { text: 'Sortie' }

  it('checks only the namespace for an unregistered zone.stratos collection', () => {
    fc.assert(
      fc.property(unregisteredStratos, (collection) => {
        expect(() =>
          enabled.assertValid(unboundedRecord, collection),
        ).not.toThrow()
        expect(
          thrownBy(() => disabled.assertValid(unboundedRecord, collection)),
        ).toMatchObject({
          code: 'ForbiddenDomain',
          message: 'Stratos namespace is not enabled on this service',
        })
      }),
    )
  })

  it('runs nothing for a collection outside zone.stratos', () => {
    fc.assert(
      fc.property(otherNamespace, (collection) => {
        expect(() =>
          disabled.assertValid(unboundedRecord, collection),
        ).not.toThrow()
      }),
    )
  })

  it('runs the enrollment rule alone, before the namespace check', () => {
    const error = thrownBy(() =>
      disabled.assertValid(unboundedRecord, ENROLLMENT),
    )

    expect(error).toBeInstanceOf(StratosValidationError)
    expect(error).toMatchObject({
      code: 'MissingBoundary',
      message: 'Record must have a boundary',
    })
  })

  it('checks the namespace before the post rules', () => {
    const error = thrownBy(() => disabled.assertValid(unboundedRecord, POST))

    expect(error).toMatchObject({
      code: 'ForbiddenDomain',
      message: 'Stratos namespace is not enabled on this service',
    })
  })

  it('runs the post rules once the namespace is enabled', () => {
    const error = thrownBy(() => enabled.assertValid(unboundedRecord, POST))

    expect(error).toMatchObject({
      code: 'MissingBoundary',
      message: 'must have a boundary',
    })
  })

  it('accepts a post inside an allowed boundary', () => {
    const record = {
      text: 'Sortie',
      createdAt: '2026-01-01T00:00:00.000Z',
      boundary: { values: [{ value: ENGINEERING }] },
    }

    expect(() => enabled.assertValid(record, POST)).not.toThrow()
  })
})

describe('the post rule input', () => {
  let postRule: NonNullable<ReturnType<typeof findRecordRule>>

  beforeEach(() => {
    postRule = findRecordRule(rules, POST)!
  })

  const bodyBoundary = { values: [{ value: ENGINEERING }] }

  it('walks the claim it is given and never the record body', () => {
    const bodyElsewhere = {
      text: 'Sortie',
      boundary: { values: [{ value: 'seele' }] },
    }

    expect(() =>
      postRule.check(bodyElsewhere, { boundaryClaim: bodyBoundary }),
    ).not.toThrow()
    expect(
      thrownBy(() =>
        postRule.check(
          { text: 'Sortie', boundary: bodyBoundary },
          { boundaryClaim: undefined },
        ),
      ),
    ).toMatchObject({
      code: 'MissingBoundary',
      message: 'must have a boundary',
    })
  })

  it('refuses a reply whose claim escapes the parent boundaries', () => {
    const reply = {
      text: 'Sortie',
      reply: {
        parent: { uri: 'at://did:plc:rei/zone.stratos.feed.post/eva00' },
        root: { uri: 'at://did:plc:rei/zone.stratos.feed.post/eva00' },
      },
    }

    const error = thrownBy(() =>
      postRule.check(reply, {
        boundaryClaim: bodyBoundary,
        parentBoundaries: [`${SERVICE_DID}/design`],
      }),
    )

    expect(error).toMatchObject({ code: 'ReplyBoundaryEscalation' })
  })
})
