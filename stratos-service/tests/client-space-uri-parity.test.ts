import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { boundaryToSpaceUri as coreBoundaryToSpaceUri } from '@northskysocial/stratos-core'
import { boundaryToSpaceUri as clientBoundaryToSpaceUri } from '@northskysocial/stratos-client'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'

const DID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:%-'
const SKEY_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~:-'

const charsFrom = (alphabet: string) => fc.constantFrom(...alphabet.split(''))

const serviceDid = fc
  .tuple(
    fc.stringMatching(/^[a-z]{1,8}$/),
    fc.array(charsFrom(DID_CHARS), { minLength: 1, maxLength: 40 }),
  )
  .map(([method, rest]) => `did:${method}:${rest.join('')}`)

const skey = fc
  .array(charsFrom(SKEY_CHARS), { minLength: 1, maxLength: 80 })
  .map((chars) => chars.join(''))

/** Mostly well formed, with the pieces the two formatters could judge differently. */
const nearValidBoundary = fc
  .tuple(
    fc.oneof(
      serviceDid,
      fc.constant('did:web:'),
      fc.constant('did:WEB:x'),
      fc.string(),
    ),
    fc.constantFrom('/', '', '//'),
    fc.oneof(
      skey,
      fc.constant('.'),
      fc.constant('..'),
      fc.constant(''),
      fc.string({ maxLength: 20 }),
      fc.string({ minLength: 513, maxLength: 520 }),
    ),
  )
  .map(([did, slash, name]) => `${did}${slash}${name}`)

const comparable = (
  result:
    | ReturnType<typeof coreBoundaryToSpaceUri>
    | ReturnType<typeof clientBoundaryToSpaceUri>,
) => (result.ok ? { ok: true, value: result.value } : { ok: false })

describe('client and core space URI formatting', () => {
  it('agree for valid boundaries', () => {
    fc.assert(
      fc.property(serviceDid, skey, (did, name) => {
        const boundary = `${did}/${name}`
        expect(
          comparable(clientBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
        ).toEqual(
          comparable(coreBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
        )
      }),
      { numRuns: 500 },
    )
  })

  it('agree on whether near-valid and arbitrary boundaries format at all', () => {
    fc.assert(
      fc.property(
        fc.oneof(nearValidBoundary, fc.string(), fc.string({ unit: 'binary' })),
        (boundary) => {
          expect(
            comparable(clientBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
          ).toEqual(
            comparable(coreBoundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)),
          )
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('agree for arbitrary space types', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(HOSTED_SPACE_TYPE),
          fc.string(),
          fc.stringMatching(/^[a-z]{2,6}(\.[a-z]{2,6}){1,3}$/),
        ),
        (spaceType) => {
          const boundary = 'did:web:nerv.example/geofront'
          expect(
            comparable(clientBoundaryToSpaceUri(boundary, spaceType)),
          ).toEqual(comparable(coreBoundaryToSpaceUri(boundary, spaceType)))
        },
      ),
      { numRuns: 500 },
    )
  })

  it('formats the known boundary the same way', () => {
    expect(
      clientBoundaryToSpaceUri(
        'did:web:nerv.example/geofront',
        HOSTED_SPACE_TYPE,
      ),
    ).toEqual({
      ok: true,
      value: 'at://did:web:nerv.example/space/zone.stratos.space.feed/geofront',
    })
  })
})
