import type { LexiconDoc } from '@atproto/lexicon'

/**
 * Inline copies of the `zone.stratos.feedgen.*` lexicons. Kept in source
 * (rather than imported from disk) so the package has no out-of-tree file
 * dependencies and TypeScript can typecheck them against `LexiconDoc`.
 *
 * Source of truth: `stratos/lexicons/zone/stratos/feedgen/*.json`.
 */

export const getFeedLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'zone.stratos.feedgen.getFeed',
  defs: {
    main: {
      type: 'query',
      description:
        'Fetch a boundary-scoped hydrated feed. Requires service-auth.',
      parameters: {
        type: 'params',
        required: ['feed'],
        properties: {
          feed: { type: 'string', description: 'Configured feed id.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          cursor: { type: 'string' },
        },
      },
      output: {
        encoding: 'application/json',
        schema: {
          type: 'object',
          required: ['feed'],
          properties: {
            cursor: { type: 'string' },
            feed: {
              type: 'array',
              items: { type: 'ref', ref: '#feedViewPost' },
            },
          },
        },
      },
      errors: [{ name: 'UnknownFeed' }, { name: 'BoundaryMismatch' }],
    },
    feedViewPost: {
      type: 'object',
      required: ['post'],
      properties: {
        post: { type: 'ref', ref: '#postView' },
      },
    },
    postView: {
      type: 'object',
      required: ['uri', 'cid', 'author', 'record', 'indexedAt'],
      properties: {
        uri: { type: 'string', format: 'at-uri' },
        cid: { type: 'string', format: 'cid' },
        author: { type: 'ref', ref: '#authorView' },
        record: { type: 'unknown' },
        indexedAt: { type: 'string', format: 'datetime' },
      },
    },
    authorView: {
      type: 'object',
      required: ['did'],
      properties: {
        did: { type: 'string', format: 'did' },
        handle: { type: 'string' },
      },
    },
  },
}

export const describeFeedLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'zone.stratos.feedgen.describeFeed',
  defs: {
    main: {
      type: 'query',
      description: 'List feeds offered by this generator.',
      output: {
        encoding: 'application/json',
        schema: {
          type: 'object',
          required: ['did', 'feeds'],
          properties: {
            did: { type: 'string', format: 'did' },
            feeds: {
              type: 'array',
              items: { type: 'ref', ref: '#feedDescription' },
            },
          },
        },
      },
    },
    feedDescription: {
      type: 'object',
      required: ['id', 'boundary'],
      properties: {
        id: { type: 'string' },
        boundary: { type: 'string' },
        displayName: { type: 'string' },
        description: { type: 'string' },
      },
    },
  },
}

export const FEEDGEN_LEXICONS: LexiconDoc[] = [
  getFeedLexicon,
  describeFeedLexicon,
]

export const NSID = {
  getFeed: 'zone.stratos.feedgen.getFeed',
  describeFeed: 'zone.stratos.feedgen.describeFeed',
} as const
