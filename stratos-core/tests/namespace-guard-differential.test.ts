import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  AtUri,
  isValidDid,
  isValidNsid,
  isValidRecordKey,
} from '@atproto/syntax'
import {
  parseRecordUri,
  PostValidator,
  StratosValidationError,
  StratosValidator,
} from '../src/index.js'
import type { StratosConfig } from '../src/index.js'
import { assertNoCrossNamespaceEmbed } from '../src/validation/post-rules.js'

// The namespace guards as they read URIs before space URIs were respelled
// (revision 895c1e29 of stratos-core/src/validation/post-rules.ts,
// post-validator.ts and spaces/domain.ts). They stay as they were; the
// properties below compare the current guards against them.
const earlierBehaviour = {
  parseSpaceRecordCollection(s: string): string | undefined {
    if (!s.startsWith('at://')) return undefined
    const parts = s.slice('at://'.length).split('/')
    if (parts[1] !== 'space' || parts.length !== 7) return undefined
    const [spaceDid, , spaceType, skey, authorDid, collection, rkey] = parts
    const skeyIsValid =
      skey.length > 0 &&
      new TextEncoder().encode(skey).length <= 512 &&
      isValidRecordKey(skey)
    const valid =
      isValidDid(spaceDid) &&
      isValidNsid(spaceType) &&
      skeyIsValid &&
      isValidDid(authorDid) &&
      isValidNsid(collection) &&
      isValidRecordKey(rkey)
    return valid ? collection : undefined
  },

  isStratosUri(uri: string): boolean {
    const spaceCollection = earlierBehaviour.parseSpaceRecordCollection(uri)
    if (spaceCollection !== undefined) {
      return spaceCollection.startsWith('zone.stratos.')
    }
    try {
      return new AtUri(uri).collection.startsWith('zone.stratos.')
    } catch {
      return false
    }
  },

  isBskyUri(uri: string): boolean {
    try {
      return new AtUri(uri).collection.startsWith('app.bsky.')
    } catch {
      return false
    }
  },

  embedRuleRefuses(uri: string, namespace: 'stratos' | 'bsky'): boolean {
    return namespace === 'stratos'
      ? earlierBehaviour.isBskyUri(uri)
      : earlierBehaviour.isStratosUri(uri)
  },

  replyRuleRefuses(uri: string): boolean {
    return !earlierBehaviour.isStratosUri(uri)
  },

  postValidatorReplyRefuses(uri: string): boolean {
    try {
      return !new AtUri(uri).collection.startsWith('zone.stratos.')
    } catch {
      return true
    }
  },
}

const config: StratosConfig = {
  serviceDid: 'did:web:nerv.tokyo.jp',
  allowedDomains: ['did:web:nerv.tokyo.jp/example-com', 'engineering'],
  retentionDays: 90,
}
const validator = new StratosValidator(config)
const postValidator = new PostValidator(config)
const ruleBoundary = {
  values: [{ value: 'did:web:nerv.tokyo.jp/example-com' }],
}
const RUNS = 3_000

const STRATOS_COLLECTIONS = ['zone.stratos.feed.post', 'zone.stratos.actor.x']
const BSKY_COLLECTIONS = ['app.bsky.feed.post', 'app.bsky.actor.profile']
const OTHER_COLLECTIONS = ['com.example.misc', 'space', '']

const scheme = fc.constantFrom('at://', 'AT://', 'At://', '')
const authority = fc.constantFrom(
  'did:plc:rei',
  'did:web:bebop.example',
  'did:plc:spikespiegel',
  'nerv.tokyo.jp',
  'Tokyo-3',
)
const collection = fc.constantFrom(
  ...STRATOS_COLLECTIONS,
  ...BSKY_COLLECTIONS,
  ...OTHER_COLLECTIONS,
)
const rkey = fc.constantFrom('eva00', '3k', 'self', 'unit01')
const pathPart = fc.oneof(rkey, collection)

const loosePathUri = fc
  .tuple(
    scheme,
    authority,
    collection,
    fc.array(pathPart, { maxLength: 4 }),
    fc.integer({ min: 1, max: 6 }),
  )
  .map(([head, host, nsid, rest, depth]) =>
    [head, [host, nsid, ...rest].slice(0, depth).join('/')].join(''),
  )

const spaceRecordParts = fc.tuple(
  fc.constantFrom('did:web:bebop.example', 'did:plc:rei'),
  fc.constantFrom('zone.stratos.space.feed', 'app.bsky.space.crew'),
  fc.constantFrom('crew', 'bebop'),
  fc.constantFrom('did:plc:fayevalentine', 'did:plc:rei'),
  fc.constantFrom(...STRATOS_COLLECTIONS, ...BSKY_COLLECTIONS, 'com.example.x'),
  rkey,
)

const newFormSpaceRecordUri = spaceRecordParts.map(
  (parts) => `at:space/${parts.join('/')}`,
)

const earlierSpellingUri = fc
  .tuple(scheme, spaceRecordParts)
  .map(
    ([head, [space, type, skey, author, nsid, key]]) =>
      `${head}${[space, 'space', type, skey, author, nsid, key].join('/')}`,
  )

// The earlier space spelling is left out: no reader recognises it any more,
// so the guards no longer refuse its Stratos records (see the legacy cases).
const embeddedUri = fc.oneof(
  loosePathUri,
  newFormSpaceRecordUri,
  fc.constantFrom(
    'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
    'hello',
    '',
  ),
  fc.string(),
)

const referenceUri = fc.oneof(embeddedUri, earlierSpellingUri)

function refuses(run: () => void): boolean {
  try {
    run()
    return false
  } catch (error) {
    expect(error).toBeInstanceOf(StratosValidationError)
    return true
  }
}

function newFormCollection(uri: string): string | undefined {
  const spaceRecord = parseRecordUri(uri)
  return spaceRecord.ok ? spaceRecord.value.collection : undefined
}

function isStrictStratosReplyUri(uri: string): boolean {
  const spaceCollection = newFormCollection(uri)
  if (spaceCollection !== undefined) {
    return spaceCollection.startsWith('zone.stratos.')
  }
  if (!uri.startsWith('at://')) return false
  const parts = uri.slice('at://'.length).split('/')
  return parts.length === 3 && parts[1].startsWith('zone.stratos.')
}

const stratosDirectionChecks: Array<[string, (uri: string) => void]> = [
  [
    'the embed rule',
    (uri) => assertNoCrossNamespaceEmbed({ record: { uri } }, 'stratos'),
  ],
  [
    'StratosValidator.assertValid',
    (uri) =>
      validator.assertValid(
        { text: 'Sortie', boundary: ruleBoundary, embed: { record: { uri } } },
        'zone.stratos.feed.post',
      ),
  ],
  [
    'StratosValidator.assertValid beside media',
    (uri) =>
      validator.assertValid(
        {
          text: 'Sortie',
          boundary: ruleBoundary,
          embed: { media: { record: { uri } } },
        },
        'zone.stratos.feed.post',
      ),
  ],
]

const bskyDirectionChecks: Array<[string, (uri: string) => void]> = [
  [
    'the embed rule',
    (uri) => assertNoCrossNamespaceEmbed({ record: { uri } }, 'bsky'),
  ],
  [
    'StratosValidator.assertBskyNoCrossNamespaceEmbed',
    (uri) =>
      StratosValidator.assertBskyNoCrossNamespaceEmbed(
        { embed: { record: { uri } } },
        'app.bsky.feed.post',
      ),
  ],
  [
    'StratosValidator.assertBskyNoCrossNamespaceEmbed beside media',
    (uri) =>
      StratosValidator.assertBskyNoCrossNamespaceEmbed(
        { embed: { media: { record: { uri } } } },
        'app.bsky.feed.post',
      ),
  ],
]

describe('namespace embed guards against their earlier behaviour', () => {
  it.each(stratosDirectionChecks)(
    'a Stratos post: %s refuses every embed it refused before',
    (_name, check) => {
      fc.assert(
        fc.property(embeddedUri, (uri) => {
          const refusedNow = refuses(() => check(uri))
          const spaceCollection = newFormCollection(uri)
          if (spaceCollection !== undefined) {
            expect(refusedNow).toBe(spaceCollection.startsWith('app.bsky.'))
          } else if (earlierBehaviour.embedRuleRefuses(uri, 'stratos')) {
            expect(refusedNow).toBe(true)
          }
        }),
        { numRuns: RUNS },
      )
    },
  )

  it.each(bskyDirectionChecks)(
    'a public post: %s refuses every embed it refused before',
    (_name, check) => {
      fc.assert(
        fc.property(embeddedUri, (uri) => {
          const refusedNow = refuses(() => check(uri))
          const spaceCollection = newFormCollection(uri)
          if (spaceCollection !== undefined) {
            expect(refusedNow).toBe(spaceCollection.startsWith('zone.stratos.'))
          } else if (earlierBehaviour.embedRuleRefuses(uri, 'bsky')) {
            expect(refusedNow).toBe(true)
          }
        }),
        { numRuns: RUNS },
      )
    },
  )
})

describe('the legacy earlier space spelling in an embed', () => {
  it.each([...stratosDirectionChecks, ...bskyDirectionChecks])(
    '%s passes it as a string that names neither namespace',
    (_name, check) => {
      fc.assert(
        fc.property(earlierSpellingUri, (uri) => {
          expect(refuses(() => check(uri))).toBe(false)
        }),
        { numRuns: RUNS },
      )
    },
  )
})

describe('PostValidator against the post rule', () => {
  const engineering = { values: [{ value: 'engineering' }] }

  it('answers every Stratos-post embed as the rule does', () => {
    fc.assert(
      fc.property(referenceUri, (uri) => {
        const ruleRefuses = refuses(() =>
          validator.assertValid(
            {
              text: 'Sortie',
              boundary: ruleBoundary,
              embed: { record: { uri } },
            },
            'zone.stratos.feed.post',
          ),
        )
        const postValidatorRefuses = refuses(() =>
          postValidator.validate({
            boundary: engineering,
            embed: { record: { uri } },
          }),
        )
        expect(postValidatorRefuses).toBe(ruleRefuses)
      }),
      { numRuns: RUNS },
    )
  })

  it('answers every reply as the rule does', () => {
    fc.assert(
      fc.property(referenceUri, (uri) => {
        // An empty URI is no reference, and the rule has never judged one.
        fc.pre(uri !== '')
        const reply = { parent: { uri }, root: { uri } }
        const ruleRefuses = refuses(() =>
          validator.assertValid(
            { text: 'Sortie', boundary: ruleBoundary, reply },
            'zone.stratos.feed.post',
          ),
        )
        const postValidatorRefuses = refuses(() =>
          postValidator.validate({ boundary: engineering, reply }),
        )
        expect(postValidatorRefuses).toBe(ruleRefuses)
      }),
      { numRuns: RUNS },
    )
  })
})

describe('reply guards against their earlier behaviour', () => {
  const replyChecks: Array<
    [string, (uri: string) => void, (uri: string) => boolean]
  > = [
    [
      'StratosValidator.assertValid',
      (uri) =>
        validator.assertValid(
          {
            text: 'Sortie',
            boundary: ruleBoundary,
            reply: { parent: { uri }, root: { uri } },
          },
          'zone.stratos.feed.post',
        ),
      earlierBehaviour.replyRuleRefuses,
    ],
    [
      'PostValidator.validate',
      (uri) =>
        postValidator.validate({
          boundary: { values: [{ value: 'engineering' }] },
          reply: { parent: { uri }, root: { uri } },
        }),
      earlierBehaviour.postValidatorReplyRefuses,
    ],
  ]

  it.each(replyChecks)(
    '%s accepts only a new-form space record or a three-part at:// record of a Stratos collection',
    (_name, check, refusedBefore) => {
      fc.assert(
        fc.property(referenceUri, (uri) => {
          // An empty URI is no reference, and the rule has never judged one.
          fc.pre(uri !== '')
          const refusedNow = refuses(() => check(uri))
          if (!refusedNow) expect(isStrictStratosReplyUri(uri)).toBe(true)
          if (newFormCollection(uri) === undefined && refusedBefore(uri)) {
            expect(refusedNow).toBe(true)
          }
        }),
        { numRuns: RUNS },
      )
    },
  )
})
