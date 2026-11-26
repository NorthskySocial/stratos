import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { TID } from '@atproto/common-web'
import {
  isRepoRevTooFarAhead,
  MAX_REPO_REV_LEAD_MS,
  parseRepoUpdateNotice,
} from '../src'

const SPACE = 'at:space/did:web:nerv.tokyo.jp/zone.stratos.space.feed/eva'
const REPO = 'did:plc:shinji-ikari'
const NOW_MS = Date.UTC(2015, 5, 22, 12)

// A TID spells its timestamp in 11 characters, so the earliest is 2^50 µs.
const EARLIEST_TID_MICROS = 2 ** 50
const LATEST_TID_MICROS = 2 ** 53 - 1

function revAt(micros: number): string {
  return TID.fromTime(micros, 0).toString()
}

const REV = revAt(NOW_MS * 1000)

function bytesOf(values: number[]): { $bytes: string } {
  return { $bytes: Buffer.from(values).toString('base64') }
}

function notice(overrides: Record<string, unknown> = {}) {
  return {
    space: SPACE,
    repo: REPO,
    repoRev: REV,
    data: bytesOf([1, 2, 3]),
    ...overrides,
  }
}

function refusal(body: unknown): string | undefined {
  const result = parseRepoUpdateNotice(body)
  return result.ok ? undefined : result.message
}

const did = fc
  .tuple(
    fc.constantFrom('plc', 'web'),
    fc.stringMatching(/^[a-z0-9][a-z0-9.]{0,30}$/),
  )
  .map(([method, id]) => `did:${method}:${id}`)

const micros = fc.integer({
  min: EARLIEST_TID_MICROS,
  max: LATEST_TID_MICROS,
})

describe('parseRepoUpdateNotice', () => {
  it('accepts a notice and decodes its data', () => {
    const result = parseRepoUpdateNotice(notice())
    expect(result).toEqual({
      ok: true,
      value: {
        space: SPACE,
        repo: REPO,
        repoRev: REV,
        data: new Uint8Array([1, 2, 3]),
      },
    })
  })

  it('leaves the space unparsed so the caller can answer SpaceNotFound', () => {
    const legacy = 'at://did:web:nerv.tokyo.jp/space/eva'
    const result = parseRepoUpdateNotice(notice({ space: legacy }))
    expect(result.ok && result.value.space).toBe(legacy)
  })

  it.each([
    ['a missing body', undefined, 'Input must be an object'],
    ['a null body', null, 'Input must be an object'],
    ['an array', [], 'Input must be an object'],
    [
      'a missing space',
      notice({ space: undefined }),
      'Input must have the property "space"',
    ],
    [
      'a numeric space',
      notice({ space: 3 }),
      'Input must have the property "space"',
    ],
    [
      'a repo that is not a DID',
      notice({ repo: 'rei-ayanami' }),
      'Input/repo must be a valid did',
    ],
    [
      'a missing repo',
      notice({ repo: undefined }),
      'Input/repo must be a valid did',
    ],
    [
      'a rev that is not a TID',
      notice({ repoRev: 'asuka' }),
      'Input/repoRev must be a valid TID',
    ],
    [
      'a numeric rev',
      notice({ repoRev: 2015 }),
      'Input/repoRev must be a valid TID',
    ],
    ['missing data', notice({ data: undefined }), 'Input/data must be bytes'],
    ['data as a string', notice({ data: 'AQID' }), 'Input/data must be bytes'],
    [
      'data as a byte array',
      notice({ data: [1, 2, 3] }),
      'Input/data must be bytes',
    ],
    [
      'data that is not base64',
      notice({ data: { $bytes: '!!!!' } }),
      'Input/data must be bytes',
    ],
    [
      'data with another key',
      notice({ data: { $bytes: 'AQID', unit: 'x' } }),
      'Input/data must be bytes',
    ],
    [
      'a CID link as data',
      notice({ data: { $link: 'bafy' } }),
      'Input/data must be bytes',
    ],
  ])('refuses %s', (_name, body, message) => {
    expect(refusal(body)).toBe(message)
  })

  it('round-trips every well-formed notice', () => {
    fc.assert(
      fc.property(
        did,
        micros,
        fc.uint8Array({ maxLength: 64 }),
        (repo, time, data) => {
          const repoRev = revAt(time)
          const result = parseRepoUpdateNotice({
            space: SPACE,
            repo,
            repoRev,
            data: { $bytes: Buffer.from(data).toString('base64') },
          })
          expect(result).toEqual({
            ok: true,
            value: { space: SPACE, repo, repoRev, data: new Uint8Array(data) },
          })
        },
      ),
    )
  })

  it('refuses every rev outside the TID grammar', () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter(
            (value) =>
              !/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(
                value,
              ),
          ),
        (repoRev) => {
          expect(refusal(notice({ repoRev }))).toBe(
            'Input/repoRev must be a valid TID',
          )
        },
      ),
    )
  })

  it('refuses every data value that is not a lone $bytes string', () => {
    fc.assert(
      fc.property(
        fc
          .jsonValue()
          .filter(
            (value) =>
              typeof value !== 'object' ||
              value === null ||
              Array.isArray(value) ||
              Object.keys(value).length !== 1 ||
              typeof (value as Record<string, unknown>).$bytes !== 'string',
          ),
        (data) => {
          expect(refusal(notice({ data }))).toBe('Input/data must be bytes')
        },
      ),
    )
  })
})

describe('isRepoRevTooFarAhead', () => {
  const limitMicros = (NOW_MS + MAX_REPO_REV_LEAD_MS) * 1000

  it('allows five minutes ahead and refuses one microsecond more', () => {
    expect(isRepoRevTooFarAhead(revAt(limitMicros), NOW_MS)).toBe(false)
    expect(isRepoRevTooFarAhead(revAt(limitMicros + 1), NOW_MS)).toBe(true)
  })

  it('measures the lead in wall-clock minutes', () => {
    const fiveMinutesMs = 300_000
    expect(
      isRepoRevTooFarAhead(revAt((NOW_MS + fiveMinutesMs) * 1000), NOW_MS),
    ).toBe(false)
    expect(
      isRepoRevTooFarAhead(revAt((NOW_MS + fiveMinutesMs) * 1000 + 1), NOW_MS),
    ).toBe(true)
  })

  it('allows any past revision', () => {
    expect(isRepoRevTooFarAhead(revAt(EARLIEST_TID_MICROS), NOW_MS)).toBe(false)
  })

  it('refuses exactly the revisions past the lead', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: Math.ceil(EARLIEST_TID_MICROS / 1000),
          max: Math.floor(LATEST_TID_MICROS / 1000),
        }),
        fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
        (nowMs, leadMicros) => {
          const revMicros = (nowMs + MAX_REPO_REV_LEAD_MS) * 1000 + leadMicros
          fc.pre(
            revMicros >= EARLIEST_TID_MICROS && revMicros <= LATEST_TID_MICROS,
          )
          expect(isRepoRevTooFarAhead(revAt(revMicros), nowMs)).toBe(
            leadMicros > 0,
          )
        },
      ),
    )
  })
})
