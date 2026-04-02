import { describe, expect, it } from 'vitest'
import { PostValidator } from '../src/index.js'
import { StratosConfig, StratosValidationError } from '../src/types.js'

describe('PostValidator', () => {
  const config: StratosConfig = {
    allowedDomains: ['engineering', 'leadership'],
    serviceDid: 'did:web:stratos.actor',
    retentionDays: 30,
  }

  const validator = new PostValidator(config)

  it('should validate a valid post', () => {
    const record = {
      text: 'Hello Stratos!',
      boundary: {
        values: [{ value: 'engineering' }],
      },
    }
    expect(() => validator.validate(record)).not.toThrow()
  })

  it('should throw if boundary is missing', () => {
    const record = {
      text: 'Hello Stratos!',
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      'Record must have a boundary',
    )
  })

  it('should throw if domain is not allowed', () => {
    const record = {
      text: 'Hello Stratos!',
      boundary: {
        values: [{ value: 'marketing' }],
      },
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      "Domain 'marketing' is not allowed",
    )
  })

  it('should validate qualified boundary belonging to this service', () => {
    const record = {
      text: 'Hello Stratos!',
      boundary: {
        values: [{ value: 'did:web:stratos.actor/engineering' }],
      },
    }
    expect(() => validator.validate(record)).not.toThrow()
  })

  it('should throw if qualified boundary belongs to another service', () => {
    const record = {
      text: 'Hello Stratos!',
      boundary: {
        values: [{ value: 'did:web:other.actor/engineering' }],
      },
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      'does not belong to this service',
    )
  })

  it('should validate reply boundary consistency', () => {
    const parentBoundaries = ['engineering', 'leadership']
    const record = {
      text: 'Reply!',
      boundary: {
        values: [{ value: 'engineering' }],
      },
      reply: {
        root: { uri: 'at://did:plc:123/zone.stratos.feed.post/1', cid: 'cid1' },
        parent: {
          uri: 'at://did:plc:123/zone.stratos.feed.post/1',
          cid: 'cid1',
        },
      },
    }
    expect(() => validator.validate(record, parentBoundaries)).not.toThrow()
  })

  it('should throw if reply boundary expands beyond parent', () => {
    const parentBoundaries = ['engineering']
    const record = {
      text: 'Reply!',
      boundary: {
        values: [{ value: 'leadership' }],
      },
      reply: {
        root: { uri: 'at://did:plc:123/zone.stratos.feed.post/1', cid: 'cid1' },
        parent: {
          uri: 'at://did:plc:123/zone.stratos.feed.post/1',
          cid: 'cid1',
        },
      },
    }
    expect(() => validator.validate(record, parentBoundaries)).toThrow(
      StratosValidationError,
    )
    expect(() => validator.validate(record, parentBoundaries)).toThrow(
      'expands beyond parent boundaries',
    )
  })

  it('should throw if reply crosses namespace', () => {
    const record = {
      text: 'Reply!',
      boundary: {
        values: [{ value: 'engineering' }],
      },
      reply: {
        root: { uri: 'at://did:plc:123/app.bsky.feed.post/1', cid: 'cid1' },
        parent: { uri: 'at://did:plc:123/app.bsky.feed.post/1', cid: 'cid1' },
      },
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      'Replies cannot cross namespace boundaries',
    )
  })

  it('should throw if embed crosses namespace', () => {
    const record = {
      text: 'Embed!',
      boundary: {
        values: [{ value: 'engineering' }],
      },
      embed: {
        $type: 'app.bsky.embed.record',
        record: { uri: 'at://did:plc:123/app.bsky.feed.post/1', cid: 'cid1' },
      },
    }
    expect(() => validator.validate(record)).toThrow(StratosValidationError)
    expect(() => validator.validate(record)).toThrow(
      'Stratos records cannot embed non-Stratos content',
    )
  })
})
