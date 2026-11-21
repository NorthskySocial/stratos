import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  buildRecordRules,
  findRecordRule,
  StratosValidationError,
  type RecordRule,
  type StratosConfig,
} from '../src/index.js'
import { SUBJECT_ERROR_MESSAGE } from '../src/validation/subject.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const POST = 'zone.stratos.feed.post'
const LIKE = 'app.bsky.feed.like'
const REPOST = 'app.bsky.feed.repost'
const INTERACTIONS = [LIKE, REPOST]

const config: StratosConfig = {
  serviceDid: SERVICE_DID,
  allowedDomains: [`${SERVICE_DID}/engineering`],
  retentionDays: 90,
}

const ruleFor = (collection: string): RecordRule => {
  const rule = findRecordRule(buildRecordRules(config), collection)
  if (!rule) throw new Error(`no rule for ${collection}`)
  return rule
}

const record = {
  $type: LIKE,
  subject: { uri: `at://did:plc:shinji-ikari/${POST}/eva01`, cid: 'bafy' },
  createdAt: '1996-10-04T00:00:00.000Z',
}
const input = (subject: unknown) => ({
  boundaryClaim: undefined,
  subject: subject as { eligible: boolean } | undefined,
})

function thrownBy(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe.each(INTERACTIONS)('the %s rule', (collection) => {
  it('is registered under its own collection', () => {
    expect(ruleFor(collection).collection).toBe(collection)
  })

  it('names posts as the only collection its subject may be in', () => {
    expect(ruleFor(collection).subject).toEqual({ collections: [POST] })
  })

  it('passes when the subject was found eligible', () => {
    expect(() =>
      ruleFor(collection).check(record, input({ eligible: true })),
    ).not.toThrow()
  })

  it.each([
    ['ineligible', { eligible: false }],
    ['not looked at', undefined],
    ['carrying no verdict', {}],
    ['carrying a truthy non-boolean', { eligible: 'true' }],
    ['carrying a number', { eligible: 1 }],
    ['carrying null', { eligible: null }],
    ['null', null],
  ])(
    'refuses a subject that is %s with the one subject error',
    (_, subject) => {
      const error = thrownBy(() =>
        ruleFor(collection).check(record, input(subject)),
      )

      expect(error).toBeInstanceOf(StratosValidationError)
      expect(error).toMatchObject({
        code: 'InvalidSubject',
        message: SUBJECT_ERROR_MESSAGE,
      })
    },
  )

  it('refuses everything but an eligible verdict of true', () => {
    fc.assert(
      fc.property(fc.anything(), (subject) => {
        const eligible = (subject as { eligible?: unknown } | null)?.eligible
        const error = thrownBy(() =>
          ruleFor(collection).check(record, input(subject)),
        )

        expect(error === undefined).toBe(eligible === true)
        if (error) {
          expect(error).toMatchObject({
            code: 'InvalidSubject',
            message: SUBJECT_ERROR_MESSAGE,
          })
        }
      }),
    )
  })
})

describe('the subject error', () => {
  it('reads the same for a like and a repost', () => {
    const errors = INTERACTIONS.map((collection) =>
      thrownBy(() => ruleFor(collection).check(record, input(undefined))),
    )

    expect(errors.map((error) => (error as Error).message)).toEqual([
      'The subject must be a post in this boundary',
      'The subject must be a post in this boundary',
    ])
  })
})
