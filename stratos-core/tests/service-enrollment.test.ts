import { describe, expect, it } from 'vitest'
import {
  InvalidServiceEnrollmentError,
  validateServiceEnrollments,
} from '../src'

const SERVICE_DID = 'did:web:stratos.actor'
const OPTIONS = {
  serviceDid: SERVICE_DID,
  allowedDomains: [`${SERVICE_DID}/engineering`, `${SERVICE_DID}/leadership`],
}

describe('validateServiceEnrollments', () => {
  it('qualifies bare boundary names against the service DID', () => {
    const result = validateServiceEnrollments(
      [{ did: 'did:web:nerv.appview', boundaries: ['engineering'] }],
      OPTIONS,
    )

    expect(result).toEqual([
      {
        did: 'did:web:nerv.appview',
        boundaries: [`${SERVICE_DID}/engineering`],
      },
    ])
  })

  it('accepts already-qualified boundaries', () => {
    const result = validateServiceEnrollments(
      [
        {
          did: 'did:web:nerv.appview',
          boundaries: [`${SERVICE_DID}/leadership`],
        },
      ],
      OPTIONS,
    )

    expect(result[0].boundaries).toEqual([`${SERVICE_DID}/leadership`])
  })

  it('returns an empty array for no entries', () => {
    expect(validateServiceEnrollments([], OPTIONS)).toEqual([])
  })

  it('throws when did is missing', () => {
    expect(() =>
      validateServiceEnrollments([{ boundaries: ['engineering'] }], OPTIONS),
    ).toThrow(InvalidServiceEnrollmentError)
    expect(() =>
      validateServiceEnrollments([{ boundaries: ['engineering'] }], OPTIONS),
    ).toThrow(/non-empty "did"/)
  })

  it('throws when did is empty', () => {
    expect(() =>
      validateServiceEnrollments(
        [{ did: '', boundaries: ['engineering'] }],
        OPTIONS,
      ),
    ).toThrow(/non-empty "did"/)
  })

  it('throws on duplicate dids across the set', () => {
    expect(() =>
      validateServiceEnrollments(
        [
          { did: 'did:web:nerv.appview', boundaries: ['engineering'] },
          { did: 'did:web:nerv.appview', boundaries: ['leadership'] },
        ],
        OPTIONS,
      ),
    ).toThrow(/duplicate service enrollment for did "did:web:nerv.appview"/)
  })

  it('throws when boundaries is not an array', () => {
    expect(() =>
      validateServiceEnrollments(
        [{ did: 'did:web:nerv.appview', boundaries: 'engineering' }],
        OPTIONS,
      ),
    ).toThrow(/must declare a "boundaries" array/)
  })

  it('throws when boundaries is empty', () => {
    expect(() =>
      validateServiceEnrollments(
        [{ did: 'did:web:nerv.appview', boundaries: [] }],
        OPTIONS,
      ),
    ).toThrow(/at least one boundary/)
  })

  it('throws when a boundary entry is an empty string', () => {
    expect(() =>
      validateServiceEnrollments(
        [{ did: 'did:web:nerv.appview', boundaries: [''] }],
        OPTIONS,
      ),
    ).toThrow(/has an invalid boundary/)
  })

  it('throws when a boundary entry is not a string', () => {
    expect(() =>
      validateServiceEnrollments(
        [{ did: 'did:web:nerv.appview', boundaries: [42] }],
        OPTIONS,
      ),
    ).toThrow(/has an invalid boundary/)
  })

  it('throws when a boundary is not in allowedDomains', () => {
    expect(() =>
      validateServiceEnrollments(
        [{ did: 'did:web:nerv.appview', boundaries: ['operations'] }],
        OPTIONS,
      ),
    ).toThrow(/references boundary .* not in allowedDomains/)
  })
})
