import type { LexiconDoc } from '@atproto/lexicon'

export const atprotoLexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: 'com.atproto.repo.createRecord',
    defs: {
      main: {
        type: 'procedure',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'collection', 'record'],
            properties: {
              repo: { type: 'string' },
              collection: { type: 'string' },
              record: { type: 'unknown' },
              rkey: { type: 'string' },
              validate: { type: 'boolean' },
              swapCommit: { type: 'string' },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'cid'],
            properties: {
              uri: { type: 'string' },
              cid: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.deleteRecord',
    defs: {
      main: {
        type: 'procedure',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'collection', 'rkey'],
            properties: {
              repo: { type: 'string' },
              collection: { type: 'string' },
              rkey: { type: 'string' },
              swapRecord: { type: 'string' },
              swapCommit: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.uploadBlob',
    defs: {
      main: {
        type: 'procedure',
        input: {
          encoding: '*/*',
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['blob'],
            properties: {
              blob: {
                type: 'unknown',
              },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.getRecord',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          properties: {
            repo: { type: 'string' },
            collection: { type: 'string' },
            rkey: { type: 'string' },
            cid: { type: 'string' },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'value'],
            properties: {
              uri: { type: 'string' },
              cid: { type: 'string' },
              value: { type: 'unknown' },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.listRecords',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          properties: {
            repo: { type: 'string' },
            collection: { type: 'string' },
            limit: { type: 'integer' },
            cursor: { type: 'string' },
            reverse: { type: 'boolean' },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['records'],
            properties: {
              cursor: { type: 'string' },
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['uri', 'cid', 'value'],
                  properties: {
                    uri: { type: 'string' },
                    cid: { type: 'string' },
                    value: { type: 'unknown' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.describeRepo',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          required: ['repo'],
          properties: {
            repo: { type: 'string' },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: [
              'handle',
              'did',
              'didDoc',
              'collections',
              'handleIsCorrect',
            ],
            properties: {
              handle: { type: 'string' },
              did: { type: 'string' },
              didDoc: { type: 'unknown' },
              collections: { type: 'array', items: { type: 'string' } },
              handleIsCorrect: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.applyWrites',
    defs: {
      main: {
        type: 'procedure',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'writes'],
            properties: {
              repo: { type: 'string' },
              validate: { type: 'boolean' },
              writes: {
                type: 'array',
                items: {
                  type: 'union',
                  refs: [
                    'com.atproto.repo.applyWrites#create',
                    'com.atproto.repo.applyWrites#update',
                    'com.atproto.repo.applyWrites#delete',
                  ],
                },
              },
              swapCommit: { type: 'string' },
            },
          },
        },
      },
      create: {
        type: 'object',
        required: ['collection', 'value'],
        properties: {
          collection: { type: 'string' },
          rkey: { type: 'string' },
          value: { type: 'unknown' },
        },
      },
      update: {
        type: 'object',
        required: ['collection', 'rkey', 'value'],
        properties: {
          collection: { type: 'string' },
          rkey: { type: 'string' },
          value: { type: 'unknown' },
        },
      },
      delete: {
        type: 'object',
        required: ['collection', 'rkey'],
        properties: {
          collection: { type: 'string' },
          rkey: { type: 'string' },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.sync.listBlobs',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          required: ['did'],
          properties: {
            did: { type: 'string' },
            since: { type: 'string' },
            limit: { type: 'integer' },
            cursor: { type: 'string' },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['cids'],
            properties: {
              cursor: { type: 'string' },
              cids: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.sync.getRecord',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          required: ['did', 'collection', 'rkey'],
          properties: {
            did: { type: 'string' },
            collection: { type: 'string' },
            rkey: { type: 'string' },
            commit: { type: 'string' },
          },
        },
        output: {
          encoding: 'application/vnd.ipld.car',
        },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.sync.getBlob',
    defs: {
      main: {
        type: 'query',
        parameters: {
          type: 'params',
          required: ['did', 'cid'],
          properties: {
            did: { type: 'string' },
            cid: { type: 'string' },
          },
        },
        output: {
          encoding: '*/*',
        },
      },
    },
  },
] as unknown[] as LexiconDoc[]
