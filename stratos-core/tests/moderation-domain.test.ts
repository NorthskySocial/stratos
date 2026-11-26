import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_SUBJECT_TYPE,
  RECORD_SUBJECT_TYPE,
  decideLabelAction,
  labelSubjectKey,
  labelVisibleToService,
  logQueryCursor,
  parseLabelCursor,
  parseLabelSubject,
  parseRecordUri,
  parseSubjectFilter,
  spaceSubjectBoundary,
  subjectQueryCursor,
  takedownMarker,
  validateLabelValue,
} from '../src'
import type { LabelSubjectInput, ParsedLabelSubject, RecordUri } from '../src'

const SERVICE_DID = 'did:web:bebop.example'
const SPIKE_DID = 'did:plc:spikespiegel7777'
const POST = 'zone.stratos.feed.post'
const REPO_URI = `at://${SPIKE_DID}/${POST}/3kbebop`
const SPACE_PREFIX = `at:space/${SERVICE_DID}/zone.stratos.space.feed/3kswordfish`
const SPACE_URI = `${SPACE_PREFIX}/${SPIKE_DID}/${POST}/3kbebop`
const CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

const record = (uri: string, cid?: string) =>
  parseLabelSubject({
    $type: RECORD_SUBJECT_TYPE,
    uri,
    ...(cid === undefined ? {} : { cid }),
  })

function expectInvalidSubject(result: ReturnType<typeof record>) {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('invalid-subject')
}

describe('parseLabelSubject', () => {
  it('accepts a repo-form URI', () => {
    const result = record(REPO_URI)
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'hosted-record',
        uri: REPO_URI,
        authorDid: SPIKE_DID,
        collection: POST,
        rkey: '3kbebop',
      },
    })
  })

  it('accepts a six-part URI with the author taken from part 4', () => {
    const result = record(SPACE_URI)
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'space-record') {
      throw new Error('expected space-record')
    }
    expect(result.value.record.spaceDid).toBe(SERVICE_DID)
    expect(result.value.record.authorDid).toBe(SPIKE_DID)
    expect(result.value.record.authorDid).not.toBe(result.value.record.spaceDid)
  })

  it('accepts an account subject', () => {
    expect(
      parseLabelSubject({ $type: ACCOUNT_SUBJECT_TYPE, did: SPIKE_DID }),
    ).toEqual({ ok: true, value: { kind: 'account', did: SPIKE_DID } })
  })

  const rejected: Array<[string, string]> = [
    ['a handle authority', `at://spike.bebop.example/${POST}/3kbebop`],
    ['a 2-component repo URI', `at://${SPIKE_DID}/${POST}`],
    ['a 4-component repo URI', `at://${SPIKE_DID}/${POST}/3kbebop/extra`],
    ['a trailing slash', `${REPO_URI}/`],
    ['a 5-part space URI', `${SPACE_PREFIX}/${SPIKE_DID}/${POST}`],
    ['a 7-part space URI', `${SPACE_URI}/extra`],
    ['a non-at:// scheme', `https://${SPIKE_DID}/${POST}/3kbebop`],
    ['a query string', `${REPO_URI}?foo=bar`],
    ['a fragment', `${REPO_URI}#frag`],
    ['a bad rkey', `at://${SPIKE_DID}/${POST}/..`],
    ['a bad NSID', `at://${SPIKE_DID}/not-an-nsid/3kbebop`],
  ]
  it.each(rejected)('rejects %s', (_name, uri) => {
    expectInvalidSubject(record(uri))
  })

  it('does not fall back to the repo form when the space parse fails', () => {
    const result = record(`${SPACE_PREFIX}/${SPIKE_DID}/${POST}`)
    expectInvalidSubject(result)
    if (!result.ok) {
      expect(result.error.spacesCode).toBe('invalid-component-count')
    }
  })

  it('rejects a non-DID account', () => {
    expectInvalidSubject(
      parseLabelSubject({ $type: ACCOUNT_SUBJECT_TYPE, did: 'faye.valentine' }),
    )
  })

  it('rejects an unknown $type', () => {
    expectInvalidSubject(
      parseLabelSubject({
        $type: 'zone.stratos.moderation.defs#bountySubject',
        uri: REPO_URI,
      }),
    )
  })

  it('rejects a record subject whose uri is not a string', () => {
    for (const uri of [42, null]) {
      expectInvalidSubject(
        parseLabelSubject({
          $type: RECORD_SUBJECT_TYPE,
          uri,
        } as unknown as LabelSubjectInput),
      )
    }
  })

  it('rejects an account subject whose did is not a string', () => {
    expectInvalidSubject(
      parseLabelSubject({
        $type: ACCOUNT_SUBJECT_TYPE,
        did: 42,
      } as unknown as LabelSubjectInput),
    )
  })

  it.each([
    ['a repo-form subject with a valid cid', REPO_URI, CID],
    ['a space-form subject with a valid cid', SPACE_URI, CID],
    ['a subject with an invalid cid', REPO_URI, 'not-a-cid'],
  ])(
    'refuses %s because a takedown covers every version',
    (_name, uri, cid) => {
      const result = record(uri, cid)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('unsupported-cid')
      expect(result.error.message).toContain('every version of a record')
      expect(result.error.message).not.toContain(cid)
    },
  )

  it('still rejects a malformed URI before looking at the cid', () => {
    expectInvalidSubject(record('not-a-uri', CID))
  })
})

describe('validateLabelValue', () => {
  it('accepts !takedown', () => {
    expect(validateLabelValue('!takedown')).toEqual({
      ok: true,
      value: '!takedown',
    })
  })

  it.each(['!hide', ''])('rejects %j', (val) => {
    const result = validateLabelValue(val)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-value')
  })
})

describe('takedownMarker', () => {
  it('returns the ref when present', () => {
    expect(takedownMarker({ seq: 7, ref: 'case-0042' })).toBe('case-0042')
  })

  it('falls back to the seq when there is no ref', () => {
    expect(takedownMarker({ seq: 7 })).toBe('7')
  })

  it('falls back to the seq when the ref is empty', () => {
    expect(takedownMarker({ seq: 7, ref: '' })).toBe('7')
  })
})

describe('decideLabelAction', () => {
  const takedown = (ref?: string) => ({
    seq: 3,
    neg: false,
    ...(ref === undefined ? {} : { ref }),
  })
  const negation = { seq: 4, neg: true }

  it('takedown with no label appends', () => {
    expect(decideLabelAction(undefined, { neg: false })).toEqual({
      kind: 'append',
    })
  })

  it('takedown over a takedown with the same ref returns the existing label', () => {
    const latest = takedown('case-0042')
    expect(decideLabelAction(latest, { neg: false, ref: 'case-0042' })).toEqual(
      { kind: 'return-existing', label: latest },
    )
  })

  it('takedown over a takedown with a different ref appends', () => {
    expect(
      decideLabelAction(takedown('case-0042'), {
        neg: false,
        ref: 'case-0043',
      }),
    ).toEqual({ kind: 'append' })
  })

  it('takedown without a ref over a takedown without a ref returns the existing label', () => {
    const latest = takedown()
    expect(decideLabelAction(latest, { neg: false })).toEqual({
      kind: 'return-existing',
      label: latest,
    })
  })

  it('treats an empty ref and a missing ref as equal', () => {
    const latest = takedown()
    expect(decideLabelAction(latest, { neg: false, ref: '' })).toEqual({
      kind: 'return-existing',
      label: latest,
    })
  })

  it('takedown with a ref over a takedown without one appends', () => {
    expect(
      decideLabelAction(takedown(), { neg: false, ref: 'case-0042' }),
    ).toEqual({ kind: 'append' })
  })

  it('takedown over a negation appends', () => {
    expect(decideLabelAction(negation, { neg: false })).toEqual({
      kind: 'append',
    })
  })

  it('negation over a takedown appends', () => {
    expect(decideLabelAction(takedown('case-0042'), { neg: true })).toEqual({
      kind: 'append',
    })
  })

  it('negation over a negation returns the existing label', () => {
    expect(decideLabelAction(negation, { neg: true })).toEqual({
      kind: 'return-existing',
      label: negation,
    })
  })

  it('negation with no label changes nothing', () => {
    expect(decideLabelAction(undefined, { neg: true })).toEqual({
      kind: 'no-change',
    })
  })
})

describe('spaceSubjectBoundary', () => {
  const recordUri = (): RecordUri => {
    const parsed = parseRecordUri(SPACE_URI)
    if (!parsed.ok) throw new Error('fixture must parse')
    return parsed.value
  }

  it('maps this service space to its boundary', () => {
    expect(spaceSubjectBoundary(recordUri(), SERVICE_DID)).toEqual({
      ok: true,
      value: `${SERVICE_DID}/3kswordfish`,
    })
  })

  it('rejects another authority as foreign-authority', () => {
    const result = spaceSubjectBoundary(recordUri(), 'did:web:other.example')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('foreign-authority')
      expect(result.error.spacesCode).toBe('service-did-mismatch')
    }
  })

  it('rejects a record URI whose space cannot be formatted as invalid-subject', () => {
    const result = spaceSubjectBoundary(
      { ...recordUri(), skey: 'bad/skey' },
      SERVICE_DID,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-subject')
      expect(result.error.spacesCode).toBe('invalid-skey')
    }
  })
})

describe('labelSubjectKey', () => {
  it('uses the exact URI for records and the DID for accounts', () => {
    const subjects: ParsedLabelSubject[] = [
      { kind: 'account', did: SPIKE_DID },
      {
        kind: 'hosted-record',
        uri: REPO_URI,
        authorDid: SPIKE_DID,
        collection: POST,
        rkey: '3kbebop',
      },
    ]
    expect(subjects.map(labelSubjectKey)).toEqual([SPIKE_DID, REPO_URI])
  })
})

describe('labelVisibleToService', () => {
  it('shows a record label that shares a boundary with the caller', () => {
    const label = {
      subjectKind: 'record' as const,
      boundaries: ['nerv', 'seele'],
    }
    expect(labelVisibleToService(label, ['seele', 'gehirn'], undefined)).toBe(
      true,
    )
  })

  it('hides a record label that shares no boundary', () => {
    const label = { subjectKind: 'record' as const, boundaries: ['nerv'] }
    expect(labelVisibleToService(label, ['seele'], ['nerv'])).toBe(false)
  })

  it('ignores member boundaries for a record label', () => {
    const label = { subjectKind: 'record' as const, boundaries: ['nerv'] }
    expect(labelVisibleToService(label, ['seele'], ['seele'])).toBe(false)
  })

  it('shows an account label when the member shares a boundary', () => {
    const label = { subjectKind: 'account' as const, boundaries: [] }
    expect(labelVisibleToService(label, ['nerv'], ['nerv', 'wille'])).toBe(true)
  })

  it('hides an account label when the member shares no boundary', () => {
    const label = { subjectKind: 'account' as const, boundaries: ['nerv'] }
    expect(labelVisibleToService(label, ['nerv'], ['wille'])).toBe(false)
  })

  it('hides an account label for a member with no enrollment', () => {
    const label = { subjectKind: 'account' as const, boundaries: ['nerv'] }
    expect(labelVisibleToService(label, ['nerv'], undefined)).toBe(false)
  })

  it('hides every label from a caller with no boundaries', () => {
    const record = { subjectKind: 'record' as const, boundaries: ['nerv'] }
    const account = { subjectKind: 'account' as const, boundaries: ['nerv'] }
    expect(labelVisibleToService(record, [], ['nerv'])).toBe(false)
    expect(labelVisibleToService(account, [], ['nerv'])).toBe(false)
  })

  it('hides a record label that has no boundaries', () => {
    const label = { subjectKind: 'record' as const, boundaries: [] }
    expect(labelVisibleToService(label, ['nerv'], ['nerv'])).toBe(false)
  })
})

describe('parseLabelCursor', () => {
  it('gives zero when the cursor is absent', () => {
    expect(parseLabelCursor(undefined)).toEqual({ ok: true, value: 0 })
  })

  it.each([
    ['0', 0],
    ['7', 7],
    ['1200', 1200],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('accepts %s', (cursor, expected) => {
    expect(parseLabelCursor(cursor)).toEqual({ ok: true, value: expected })
  })

  it.each([
    '',
    '01',
    '00',
    '+5',
    '-1',
    '1.5',
    '1e3',
    '0x10',
    ' 5',
    '5 ',
    'faye',
    String(Number.MAX_SAFE_INTEGER + 1),
    '99999999999999999999',
  ])('rejects %j', (cursor) => {
    const result = parseLabelCursor(cursor)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-cursor')
  })
})

describe('parseSubjectFilter', () => {
  it('gives undefined when the field is omitted', () => {
    expect(parseSubjectFilter(undefined)).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it('rejects an empty array', () => {
    const result = parseSubjectFilter([])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-subject')
  })

  it('accepts DIDs and both record URI forms', () => {
    expect(parseSubjectFilter([SPIKE_DID, REPO_URI, SPACE_URI])).toEqual({
      ok: true,
      value: [SPIKE_DID, REPO_URI, SPACE_URI],
    })
  })

  it('removes duplicates and keeps first-seen order', () => {
    expect(
      parseSubjectFilter([REPO_URI, SPIKE_DID, REPO_URI, SPIKE_DID]),
    ).toEqual({
      ok: true,
      value: [REPO_URI, SPIKE_DID],
    })
  })

  it.each([
    '',
    'faye-valentine',
    'did:',
    `at://${SPIKE_DID}/${POST}`,
    'at://x/y/z',
  ])('rejects %j', (item) => {
    const result = parseSubjectFilter([SPIKE_DID, item])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-subject')
  })
})

describe('logQueryCursor', () => {
  it('resumes after the last scanned label', () => {
    expect(logQueryCursor(3, 20)).toBe('20')
  })

  it('keeps the input cursor when nothing was scanned', () => {
    expect(logQueryCursor(3, undefined)).toBe('3')
  })
})

describe('subjectQueryCursor', () => {
  it('moves to the log head', () => {
    expect(subjectQueryCursor(3, 40)).toBe('40')
  })

  it('never moves behind the input cursor', () => {
    expect(subjectQueryCursor(50, 40)).toBe('50')
  })
})

describe('legacy space URIs as label subjects', () => {
  const LEGACY_SPACE_URI = `at://${SERVICE_DID}/space/zone.stratos.space.feed/3kswordfish`
  const LEGACY_SPACE_RECORD_URI = `${LEGACY_SPACE_URI}/${SPIKE_DID}/${POST}/3kbebop`

  it.each([
    ['a legacy space', LEGACY_SPACE_URI],
    ['a legacy space record', LEGACY_SPACE_RECORD_URI],
  ])('refuses %s through the hosted-record parse', (_name, uri) => {
    const result = record(uri)
    expectInvalidSubject(result)
    if (!result.ok) {
      expect(result.error.spacesCode).toBeUndefined()
      expect(result.error.message).toContain('components')
    }
  })

  it('refuses a legacy space record in a subject filter', () => {
    const result = parseSubjectFilter([SPIKE_DID, LEGACY_SPACE_RECORD_URI])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-subject')
  })

  it('chooses the space parse by the at:space/ prefix and keeps the submitted string as the key', () => {
    const result = record(SPACE_URI)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('space-record')
    expect(labelSubjectKey(result.value)).toBe(SPACE_URI)
  })

  it('refuses a space-prefixed string that is not a record without trying the repo form', () => {
    const result = record(SPACE_PREFIX)
    expectInvalidSubject(result)
    if (!result.ok)
      expect(result.error.spacesCode).toBe('invalid-component-count')
  })
})
