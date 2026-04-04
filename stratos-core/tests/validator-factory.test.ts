import { describe, expect, it } from 'vitest'
import {
  EnrollmentRecordValidator,
  PostValidator,
  ValidatorFactory,
} from '../src/index.js'
import { StratosConfig } from '../src/types.js'

describe('ValidatorFactory', () => {
  const config: StratosConfig = {
    allowedDomains: ['engineering', 'leadership'],
    serviceDid: 'did:web:stratos.actor',
    retentionDays: 30,
  }

  it('should provide PostValidator for post collection', () => {
    const factory = new ValidatorFactory(config)
    const validator = factory.getValidator('zone.stratos.feed.post')
    expect(validator).toBeInstanceOf(PostValidator)
  })

  it('should provide EnrollmentRecordValidator for enrollment collection', () => {
    const factory = new ValidatorFactory(config)
    const validator = factory.getValidator('zone.stratos.actor.enrollment')
    expect(validator).toBeInstanceOf(EnrollmentRecordValidator)
  })

  it('should return undefined for unknown collection', () => {
    const factory = new ValidatorFactory(config)
    const validator = factory.getValidator('unknown.collection')
    expect(validator).toBeUndefined()
  })

  it('should allow registering new validators', () => {
    const factory = new ValidatorFactory(config)
    const mockValidator = {
      collection: 'mock.collection',
      validate: async () => ({ valid: true }),
    }
    factory.register(mockValidator)
    expect(factory.getValidator('mock.collection')).toBe(mockValidator)
  })
})
