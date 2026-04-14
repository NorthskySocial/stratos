import type { LexiconDoc } from '@atproto/lexicon'

export const atprotoLexicons: LexiconDoc[] = [
  {
    lexicon: 1,
    id: 'com.atproto.repo.createRecord',
    defs: {
      main: {
        type: 'procedure',
        input: { encoding: 'application/json' },
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.deleteRecord',
    defs: {
      main: {
        type: 'procedure',
        input: { encoding: 'application/json' },
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.uploadBlob',
    defs: {
      main: {
        type: 'procedure',
        input: { encoding: '*/*' },
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.getRecord',
    defs: {
      main: {
        type: 'query',
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.listRecords',
    defs: {
      main: {
        type: 'query',
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.describeRepo',
    defs: {
      main: {
        type: 'query',
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.repo.applyWrites',
    defs: {
      main: {
        type: 'procedure',
        input: { encoding: 'application/json' },
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.sync.listBlobs',
    defs: {
      main: {
        type: 'query',
        output: { encoding: 'application/json' },
      },
    },
  },
  {
    lexicon: 1,
    id: 'com.atproto.sync.getRecord',
    defs: {
      main: {
        type: 'query',
        output: { encoding: 'application/vnd.ipld.car' },
      },
    },
  },
] as unknown[] as LexiconDoc[]
