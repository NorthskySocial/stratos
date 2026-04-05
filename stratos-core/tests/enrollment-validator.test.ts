import { describe, expect, it } from 'vitest'
import {
  EnrollmentRecordValidator,
  StratosConfig,
  StratosValidationError,
} from '../src'

describe('EnrollmentRecordValidator', () => {
  const config: StratosConfig = {
    allowedDomains: ['engineering', 'leadership'],
    serviceDid: 'did:web:stratos.actor',
    retentionDays: 30,
  }

  const validator = new EnrollmentRecordValidator(config)

  it('should validate a valid enrollment', () => {
    const record = {
      service: 'https://stratos.actor',
      boundary: {
        values: [{ value: 'engineering' }],
      },
    }
    expect(() => validator.validate(record)).not.toThrow()
  })

  it('should throw if boundary is missing', () => {
    const record = {
      service: 'https://stratos.actor',
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      'Record must have a boundary',
    )
  })

  it('should throw if domain is not allowed', () => {
    const record = {
      service: 'https://stratos.actor',
      boundary: {
        values: [{ value: 'unauthorized' }],
      },
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      'is not allowed for this service',
    )
  })
})
