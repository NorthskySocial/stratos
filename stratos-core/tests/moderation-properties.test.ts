import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  RECORD_SUBJECT_TYPE,
  decideLabelAction,
  formatRecordUri,
  labelSubjectKey,
  parseLabelSubject,
  takedownMarker,
} from '../src'
import type { ExistingLabel, LabelRequest, ParsedLabelSubject } from '../src'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'.split('')
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
const RKEY_CHARS = [...ALNUM, 'A', 'B', '.', '_', ':', '~', '-']

const didArb = fc.oneof(
  fc
    .array(fc.constantFrom(...BASE32), { minLength: 24, maxLength: 24 })
    .map((chars) => `did:plc:${chars.join('')}`),
  fc
    .array(fc.constantFrom(...ALNUM), { minLength: 3, maxLength: 12 })
    .map((chars) => `did:web:${chars.join('')}.example`),
)

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')
const labelArb = fc
  .tuple(
    fc.constantFrom(...LETTERS),
    fc.array(fc.constantFrom(...ALNUM), { maxLength: 9 }),
  )
  .map(([first, rest]) => first + rest.join(''))
const nsidArb = fc
  .tuple(labelArb, labelArb, labelArb)
  .map(([a, b, c]) => `${a}.${b}.${c}`)
const rkeyArb = fc
  .array(fc.constantFrom(...RKEY_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''))
  .filter((rkey) => rkey !== '.' && rkey !== '..')

const record = (uri: string) =>
  parseLabelSubject({ $type: RECORD_SUBJECT_TYPE, uri })

describe('moderation subject properties', () => {
  it('parses every valid repo-form URI as a hosted record', () => {
    fc.assert(
      fc.property(didArb, nsidArb, rkeyArb, (did, collection, rkey) => {
        const result = record(`at://${did}/${collection}/${rkey}`)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value).toMatchObject({
          kind: 'hosted-record',
          authorDid: did,
          collection,
          rkey,
        })
      }),
    )
  })

  it('rejects every repo-form URI whose authority is a handle', () => {
    const handleArb = fc
      .tuple(labelArb, labelArb)
      .map(([name, domain]) => `${name}.${domain}.example`)
    fc.assert(
      fc.property(handleArb, nsidArb, rkeyArb, (handle, collection, rkey) => {
        const result = record(`at://${handle}/${collection}/${rkey}`)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('invalid-subject')
      }),
    )
  })

  it('parses every valid seven-segment URI as a space record', () => {
    fc.assert(
      fc.property(
        didArb,
        nsidArb,
        rkeyArb,
        didArb,
        nsidArb,
        rkeyArb,
        (spaceDid, spaceType, skey, authorDid, collection, rkey) => {
          const parts = {
            spaceDid,
            spaceType,
            skey,
            authorDid,
            collection,
            rkey,
          }
          const uri = formatRecordUri(parts)
          expect(uri.ok).toBe(true)
          if (!uri.ok) return
          const result = record(uri.value)
          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.value).toMatchObject({
            kind: 'space-record',
            uri: uri.value,
            record: parts,
          })
        },
      ),
    )
  })

  it('rejects every URI whose component count is outside the grammar', () => {
    const componentArb = fc.oneof(
      fc.constant('x'),
      didArb,
      nsidArb,
      rkeyArb,
      fc.constant('space'),
    )
    const badCount = fc
      .array(componentArb, { maxLength: 12 })
      .filter((parts) => parts.length !== (parts[1] === 'space' ? 7 : 3))
    fc.assert(
      fc.property(badCount, (parts) => {
        const result = record(`at://${parts.join('/')}`)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('invalid-subject')
      }),
    )
  })

  it('rejects a valid URI whose at:// scheme is replaced', () => {
    const wrongPrefixArb = fc
      .oneof(
        fc.string({ minLength: 5, maxLength: 5 }),
        fc.constantFrom('', 'at:/', 'at:', 'https://', 'did:'),
      )
      .filter((prefix) => !prefix.startsWith('at://'))
    const validUriArb = fc.oneof(
      fc
        .tuple(didArb, nsidArb, rkeyArb)
        .map(([did, collection, rkey]) => `${did}/${collection}/${rkey}`),
      fc
        .tuple(didArb, nsidArb, rkeyArb, didArb, nsidArb, rkeyArb)
        .map(
          ([spaceDid, spaceType, skey, authorDid, collection, rkey]) =>
            `${spaceDid}/space/${spaceType}/${skey}/${authorDid}/${collection}/${rkey}`,
        ),
    )
    fc.assert(
      fc.property(wrongPrefixArb, validUriArb, (prefix, rest) => {
        const result = record(`${prefix}${rest}`)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('invalid-subject')
      }),
      { numRuns: 200 },
    )
  })

  it('rejects a valid repo-form URI followed by extra components', () => {
    fc.assert(
      fc.property(
        didArb,
        nsidArb,
        rkeyArb,
        fc.array(rkeyArb, { minLength: 1, maxLength: 4 }),
        (did, collection, rkey, extra) => {
          const result = record(
            `at://${did}/${collection}/${rkey}/${extra.join('/')}`,
          )
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error.code).toBe('invalid-subject')
        },
      ),
    )
  })

  it('rejects a space-marked URI with 6 or 8+ components', () => {
    fc.assert(
      fc.property(
        didArb,
        fc.array(rkeyArb, { minLength: 4, maxLength: 4 }),
        fc.constantFrom(-1, 1, 2, 3),
        (did, rest, delta) => {
          const tail = Array.from({ length: 5 + delta }, (_, i) =>
            i < rest.length ? rest[i] : 'x',
          )
          const result = record(`at://${did}/space/${tail.join('/')}`)
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error.code).toBe('invalid-subject')
        },
      ),
    )
  })
})

describe('takedownMarker properties', () => {
  it('is never empty and equals a non-empty ref', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
        (seq, ref) => {
          const marker = takedownMarker({ seq, ref })
          expect(marker).not.toBe('')
          if (ref !== undefined && ref !== '') expect(marker).toBe(ref)
        },
      ),
    )
  })
})

describe('decideLabelAction properties', () => {
  const requestArb: fc.Arbitrary<LabelRequest> = fc.record(
    {
      neg: fc.boolean(),
      ref: fc.constantFrom('', 'case-0042', 'case-0043'),
    },
    { requiredKeys: ['neg'] },
  )

  function apply(log: ExistingLabel[], request: LabelRequest) {
    const latest = log[log.length - 1]
    const decision = decideLabelAction(latest, request)
    if (decision.kind === 'append') {
      log.push({ seq: log.length + 1, neg: request.neg, ref: request.ref })
    }
    return { decision, latest }
  }

  it('is idempotent and never stacks identical takedowns', () => {
    fc.assert(
      fc.property(fc.array(requestArb, { maxLength: 20 }), (requests) => {
        const log: ExistingLabel[] = []
        for (const request of requests) {
          const { decision, latest } = apply(log, request)
          if (request.neg && (latest === undefined || latest.neg)) {
            expect(decision.kind).not.toBe('append')
          }
        }
        const last = requests[requests.length - 1]
        if (last !== undefined) {
          expect(apply(log, last).decision.kind).not.toBe('append')
        }
        for (let i = 1; i < log.length; i++) {
          const [prev, next] = [log[i - 1], log[i]]
          const identicalTakedowns =
            !prev.neg && !next.neg && (prev.ref ?? '') === (next.ref ?? '')
          expect(identicalTakedowns).toBe(false)
        }
      }),
    )
  })
})

describe('labelSubjectKey properties', () => {
  const sharedAuthorArb = fc.constantFrom(
    'did:plc:spikespiegel7777',
    'did:plc:fayevalentine88',
  )
  const subjectArb: fc.Arbitrary<ParsedLabelSubject> = fc.oneof(
    sharedAuthorArb.map((did) => ({ kind: 'account' as const, did })),
    didArb.map((did) => ({ kind: 'account' as const, did })),
    fc
      .tuple(
        fc.oneof(sharedAuthorArb, didArb),
        fc.constantFrom('zone.stratos.feed.post', 'zone.stratos.feed.like'),
        fc.constantFrom('3kbebop', '3kswordfish'),
      )
      .map(([authorDid, collection, rkey]) => ({
        kind: 'hosted-record' as const,
        uri: `at://${authorDid}/${collection}/${rkey}`,
        authorDid,
        collection,
        rkey,
      })),
  )
  const identity = (s: ParsedLabelSubject) =>
    s.kind === 'account' ? `account:${s.did}` : `record:${s.uri}`

  it('is injective over record and account subjects', () => {
    fc.assert(
      fc.property(subjectArb, subjectArb, (a, b) => {
        expect(labelSubjectKey(a) === labelSubjectKey(b)).toBe(
          identity(a) === identity(b),
        )
      }),
    )
  })

  it('separates an account from a record by the same author', () => {
    fc.assert(
      fc.property(didArb, nsidArb, rkeyArb, (did, collection, rkey) => {
        const hosted: ParsedLabelSubject = {
          kind: 'hosted-record',
          uri: `at://${did}/${collection}/${rkey}`,
          authorDid: did,
          collection,
          rkey,
        }
        expect(labelSubjectKey(hosted)).not.toBe(
          labelSubjectKey({ kind: 'account', did }),
        )
      }),
    )
  })
})
