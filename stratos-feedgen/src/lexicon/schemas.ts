import type { LexiconDoc } from '@atproto/lexicon'

// Inline copies keep the package independent of out-of-tree JSON files.

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
          feed: {
            type: 'string',
            description: 'Configured feed id.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 50,
          },
          cursor: {
            type: 'string',
          },
        },
      },
      output: {
        encoding: 'application/json',
        schema: {
          type: 'object',
          required: ['feed'],
          properties: {
            cursor: {
              type: 'string',
            },
            feed: {
              type: 'array',
              items: {
                type: 'ref',
                ref: '#feedViewPost',
              },
            },
          },
        },
      },
      errors: [
        {
          name: 'UnknownFeed',
        },
        {
          name: 'BoundaryMismatch',
        },
      ],
    },
    feedViewPost: {
      type: 'object',
      required: ['post'],
      properties: {
        post: {
          type: 'ref',
          ref: '#postView',
        },
      },
    },
    postView: {
      type: 'object',
      required: ['uri', 'cid', 'author', 'record', 'indexedAt', 'boundaries'],
      properties: {
        uri: {
          type: 'string',
          description: 'AT URI or permissioned space record URI.',
        },
        cid: {
          type: 'string',
          format: 'cid',
        },
        author: {
          type: 'ref',
          ref: '#authorView',
        },
        record: {
          type: 'unknown',
        },
        indexedAt: {
          type: 'string',
          format: 'datetime',
        },
        boundaries: {
          type: 'array',
          items: {
            type: 'string',
          },
          minLength: 1,
        },
        blobs: {
          type: 'array',
          items: {
            type: 'ref',
            ref: '#blobView',
          },
          description:
            'Authenticated feedgen blob URLs. Record blob refs remain unchanged. Absent for custody whose blobs must be read from the host.',
        },
      },
    },
    authorView: {
      type: 'object',
      required: ['did'],
      properties: {
        did: {
          type: 'string',
          format: 'did',
        },
        handle: {
          type: 'string',
        },
      },
    },
    blobView: {
      type: 'object',
      required: ['cid', 'url'],
      properties: {
        cid: {
          type: 'string',
          format: 'cid',
        },
        url: {
          type: 'string',
          format: 'uri',
        },
        mimeType: {
          type: 'string',
        },
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
            did: {
              type: 'string',
              format: 'did',
            },
            feeds: {
              type: 'array',
              items: {
                type: 'ref',
                ref: '#feedDescription',
              },
            },
          },
        },
      },
    },
    feedDescription: {
      type: 'object',
      required: ['id', 'boundary'],
      properties: {
        id: {
          type: 'string',
        },
        boundary: {
          type: 'string',
        },
        displayName: {
          type: 'string',
        },
        description: {
          type: 'string',
        },
      },
    },
  },
}

export const getBlobLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'zone.stratos.feedgen.getBlob',
  defs: {
    main: {
      type: 'query',
      description:
        'Read a Stratos-hosted blob attached to an accessible indexed post. Requires service-auth scoped to this method. Responses are private and must not be shared or cached by HTTP intermediaries.',
      parameters: {
        type: 'params',
        required: ['uri', 'cid'],
        properties: {
          uri: {
            type: 'string',
            description: 'Exact indexed post URI, including space record URIs.',
          },
          cid: {
            type: 'string',
            format: 'cid',
          },
        },
      },
      output: {
        encoding: '*/*',
      },
      errors: [
        {
          name: 'BlobNotFound',
        },
        {
          name: 'BlobTooLarge',
        },
        {
          name: 'BlobBusy',
        },
        {
          name: 'FeedNotReady',
        },
      ],
    },
  },
}

export const FEEDGEN_LEXICONS: LexiconDoc[] = [
  getFeedLexicon,
  describeFeedLexicon,
  getBlobLexicon,
]

export const NSID = {
  getFeed: 'zone.stratos.feedgen.getFeed',
  describeFeed: 'zone.stratos.feedgen.describeFeed',
  getBlob: 'zone.stratos.feedgen.getBlob',
} as const
