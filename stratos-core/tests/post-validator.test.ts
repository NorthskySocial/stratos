import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PostValidator, StratosConfig, StratosValidationError } from '../src'

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

  describe('record URIs of both custodies', () => {
    const corpus = JSON.parse(
      readFileSync(
        new URL(
          '../../test/spaces-alignment/november/fixtures/space-uri-conformance.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { invalid: Array<{ name: string; input: string }> }
    const LEGACY_SPACE_RECORD_URI = corpus.invalid.find(
      (entry) => entry.name === 'the old spelling of a record',
    )?.input as string
    const space = 'at:space/did:web:bebop.example/zone.stratos.space.feed/crew'
    const author = 'did:plc:fayevalentine'
    const rows: Array<[string, string, 'accepted' | 'refused']> = [
      [
        'a custody stratos post',
        `at://${author}/zone.stratos.feed.post/3k`,
        'accepted',
      ],
      [
        'a custody bsky post',
        `at://${author}/app.bsky.feed.post/3k`,
        'refused',
      ],
      [
        'a space record of a stratos collection',
        `${space}/${author}/zone.stratos.feed.post/3k`,
        'accepted',
      ],
      [
        'a space record of a bsky collection',
        `${space}/${author}/app.bsky.feed.post/3k`,
        'refused',
      ],
      ['a legacy space record', LEGACY_SPACE_RECORD_URI, 'refused'],
      ['a string that is no URI', 'hello', 'refused'],
      [
        'a seven-part at:// URI',
        `at://${author}/zone.stratos.feed.post/3k/a/b/c`,
        'refused',
      ],
      [
        'a bsky record URI with a trailing part',
        `at://${author}/app.bsky.feed.post/3k/extra`,
        'refused',
      ],
      [
        'a bsky collection URI without a record key',
        `at://${author}/app.bsky.feed.post`,
        'refused',
      ],
      [
        'a bsky record URI with an upper-case scheme',
        `AT://${author}/app.bsky.feed.post/3k`,
        'refused',
      ],
      [
        'a bsky record URI without a scheme',
        `${author}/app.bsky.feed.post/3k`,
        'refused',
      ],
    ]
    const boundary = { values: [{ value: 'engineering' }] }

    it.each(rows)('reply parent and root: %s is %s', (_name, uri, outcome) => {
      const record = {
        boundary,
        reply: { parent: { uri, cid: 'c' }, root: { uri, cid: 'c' } },
      }
      if (outcome === 'accepted') {
        expect(() => validator.validate(record)).not.toThrow()
      } else {
        expect(() => validator.validate(record)).toThrow(
          expect.objectContaining({ code: 'CrossNamespaceReply' }),
        )
      }
    })

    it.each(['parent', 'root'] as const)(
      'refuses a legacy space record as the reply %s alone',
      (field) => {
        const good = {
          uri: `at://${author}/zone.stratos.feed.post/3k`,
          cid: 'c',
        }
        const bad = { uri: LEGACY_SPACE_RECORD_URI, cid: 'c' }
        const record = {
          boundary,
          reply:
            field === 'parent'
              ? { parent: bad, root: good }
              : { parent: good, root: bad },
        }
        expect(() => validator.validate(record)).toThrow(
          expect.objectContaining({ code: 'CrossNamespaceReply' }),
        )
      },
    )

    // The embed rule only refuses a bsky collection, so a string that names no
    // collection is left to the lexicon check.
    const unclassified = new Set([
      'a legacy space record',
      'a string that is no URI',
      'a seven-part at:// URI',
    ])

    it.each(rows)('embed: %s is %s', (name, uri, outcome) => {
      const record = { boundary, embed: { record: { uri, cid: 'c' } } }
      if (outcome === 'accepted' || unclassified.has(name)) {
        expect(() => validator.validate(record)).not.toThrow()
      } else {
        expect(() => validator.validate(record)).toThrow(
          expect.objectContaining({ code: 'CrossNamespaceEmbed' }),
        )
      }
    })

    it('answers with a validation error, never another error, for a reply without uris', () => {
      expect(() =>
        validator.validate({ boundary, reply: { parent: {}, root: null } }),
      ).toThrow(expect.objectContaining({ code: 'CrossNamespaceReply' }))
      expect(() =>
        validator.validate({ boundary, reply: { parent: { uri: 7 } } }),
      ).toThrow(expect.objectContaining({ code: 'CrossNamespaceReply' }))
    })
  })
})
