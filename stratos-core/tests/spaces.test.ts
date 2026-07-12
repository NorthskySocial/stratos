import { describe, expect, it } from 'vitest'
import {
  AT_SCHEME,
  SPACE_SEGMENT,
  boundaryToSpaceUri,
  formatRecordUri,
  formatSpaceUri,
  isSyntacticDid,
  isValidNsidStr,
  isValidSkey,
  parseRecordUri,
  parseSpaceUri,
  spaceUriToBoundary,
  utf8ByteLength,
  type RecordUri,
  type SpaceUri,
  type SpacesResult,
} from '../src'

const SERVICE_DID = 'did:web:nerv.example.com'
const AUTHOR_DID = 'did:plc:spike23bebop'
const SPACE_TYPE = 'zone.stratos.space.pottery'
const COLLECTION = 'app.bsky.feed.post'
const SKEY = 'bebop'

const VALID_SPACE_URI = `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}`
const VALID_RECORD_URI = `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}/${AUTHOR_DID}/${COLLECTION}/3k2a`

function expectOk<T>(r: SpacesResult<T>): T {
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error.code}`)
  return r.value
}

function expectErr<T>(r: SpacesResult<T>): string {
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected error, got ok')
  return r.error.code
}

// Builds an `at://` URI with the correct marker at the segment after the
// authority and exactly `n` `/`-separated components, so component-count checks
// can be tested in isolation from the marker check.
function markerUriWithSegments(n: number): string {
  const segs = [SERVICE_DID, SPACE_SEGMENT]
  while (segs.length < n) segs.push('x')
  return AT_SCHEME + segs.join('/')
}

describe('spaces addressing', () => {
  describe('utf8ByteLength', () => {
    it('counts ASCII as one byte each', () => {
      expect(utf8ByteLength('abc')).toBe(3)
      expect(utf8ByteLength('')).toBe(0)
    })

    it('counts multi-byte UTF-8 by bytes, not code points', () => {
      // "é" is 2 bytes; "😀" is 4 bytes.
      expect(utf8ByteLength('é')).toBe(2)
      expect(utf8ByteLength('😀')).toBe(4)
    })
  })

  describe('isValidSkey', () => {
    it('accepts simple ASCII record-key syntax', () => {
      expect(isValidSkey('pottery')).toBe(true)
      expect(isValidSkey('a.b_c:d~e-f')).toBe(true)
      expect(isValidSkey('3k2a')).toBe(true)
    })

    it('accepts a 512-byte skey and rejects a 513-byte skey', () => {
      const s512 = 'a'.repeat(512)
      const s513 = 'a'.repeat(513)
      expect(utf8ByteLength(s512)).toBe(512)
      expect(utf8ByteLength(s513)).toBe(513)
      expect(isValidSkey(s512)).toBe(true)
      expect(isValidSkey(s513)).toBe(false)
    })

    it('rejects empty skey (0 bytes)', () => {
      expect(isValidSkey('')).toBe(false)
    })

    it('rejects "." and ".."', () => {
      expect(isValidSkey('.')).toBe(false)
      expect(isValidSkey('..')).toBe(false)
    })

    it('rejects invalid characters', () => {
      expect(isValidSkey('has/slash')).toBe(false)
      expect(isValidSkey('has space')).toBe(false)
      expect(isValidSkey('has#hash')).toBe(false)
    })

    it('rejects multi-byte characters as invalid characters (ASCII-only alphabet)', () => {
      // "é" is within 512 bytes but is not in the ASCII record-key alphabet,
      // so it must be rejected on character grounds.
      expect(utf8ByteLength('é')).toBeLessThanOrEqual(512)
      expect(isValidSkey('é')).toBe(false)
      expect(isValidSkey('café')).toBe(false)
      expect(isValidSkey('😀')).toBe(false)
    })

    it('enforces the byte-length rule independently on the raw byte counter', () => {
      // A 511-code-point string of 2-byte chars has 1022 UTF-8 bytes, which
      // exceeds 512 bytes. The byte counter must reflect that regardless of the
      // character-set check.
      const multiByte = 'é'.repeat(511)
      expect(multiByte.length).toBe(511) // 511 code units / code points
      expect(utf8ByteLength(multiByte)).toBe(1022) // but 1022 UTF-8 bytes
      expect(utf8ByteLength(multiByte)).toBeGreaterThan(512)
      // And such a string is rejected as an skey (both facets fail).
      expect(isValidSkey(multiByte)).toBe(false)

      // Pure byte-length facet, isolated from the alphabet: an all-ASCII
      // 513-byte string is over the byte limit.
      expect(utf8ByteLength('x'.repeat(513))).toBe(513)
    })

    it('byte-counts skeys past the fast-path length cutoff', () => {
      // Strings up to 170 code units cannot exceed 512 bytes and skip the byte
      // count; past that they are byte-counted. 200 ASCII chars is 200 bytes
      // (accepted); 200 three-byte chars is 600 bytes (rejected).
      const asciiOk = 'a'.repeat(200)
      expect(utf8ByteLength(asciiOk)).toBe(200)
      expect(isValidSkey(asciiOk)).toBe(true)
      const multiByteOver = 'あ'.repeat(200)
      expect(multiByteOver.length).toBe(200)
      expect(utf8ByteLength(multiByteOver)).toBe(600)
      expect(isValidSkey(multiByteOver)).toBe(false)
    })
  })

  describe('isSyntacticDid', () => {
    it('accepts well-formed DIDs', () => {
      expect(isSyntacticDid('did:plc:abc123')).toBe(true)
      expect(isSyntacticDid('did:web:nerv.example.com')).toBe(true)
    })

    it('rejects empty / malformed DIDs', () => {
      expect(isSyntacticDid('')).toBe(false)
      expect(isSyntacticDid('did:plc:')).toBe(false)
      expect(isSyntacticDid('did:')).toBe(false)
      expect(isSyntacticDid('notadid')).toBe(false)
      // DIDs cannot contain "/", so a boundary string is not a DID.
      expect(isSyntacticDid('did:web:nerv.example.com/pottery')).toBe(false)
    })
  })

  describe('isValidNsidStr', () => {
    it('accepts valid NSIDs', () => {
      expect(isValidNsidStr('app.bsky.feed.post')).toBe(true)
      expect(isValidNsidStr('zone.stratos.space.pottery')).toBe(true)
    })

    it('rejects non-NSIDs', () => {
      expect(isValidNsidStr('nope')).toBe(false)
      expect(isValidNsidStr('a.b')).toBe(false)
      expect(isValidNsidStr('')).toBe(false)
    })
  })

  describe('parseSpaceUri / formatSpaceUri round-trip', () => {
    it('round-trips a valid space URI byte-exactly', () => {
      const parts = expectOk(parseSpaceUri(VALID_SPACE_URI))
      expect(parts).toEqual({
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: SKEY,
      } satisfies SpaceUri)
      const reformatted = expectOk(formatSpaceUri(parts))
      expect(reformatted).toBe(VALID_SPACE_URI)
    })

    it('format then parse yields the same parts', () => {
      const parts: SpaceUri = {
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: 'swordfish',
      }
      const uri = expectOk(formatSpaceUri(parts))
      expect(expectOk(parseSpaceUri(uri))).toEqual(parts)
    })
  })

  describe('parseRecordUri / formatRecordUri round-trip', () => {
    it('round-trips a valid record URI byte-exactly', () => {
      const parts = expectOk(parseRecordUri(VALID_RECORD_URI))
      expect(parts).toEqual({
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: SKEY,
        authorDid: AUTHOR_DID,
        collection: COLLECTION,
        rkey: '3k2a',
      } satisfies RecordUri)
      const reformatted = expectOk(formatRecordUri(parts))
      expect(reformatted).toBe(VALID_RECORD_URI)
    })

    it('format then parse yields the same parts', () => {
      const parts: RecordUri = {
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: SKEY,
        authorDid: AUTHOR_DID,
        collection: COLLECTION,
        rkey: 'self',
      }
      const uri = expectOk(formatRecordUri(parts))
      expect(expectOk(parseRecordUri(uri))).toEqual(parts)
    })
  })

  describe('scheme rejection', () => {
    it('rejects the retired ats:// scheme', () => {
      const spaceLike = `ats://${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}`
      const recordLike = `ats://${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}/${AUTHOR_DID}/${COLLECTION}/3k2a`
      expect(expectErr(parseSpaceUri(spaceLike))).toBe('invalid-scheme')
      expect(expectErr(parseRecordUri(recordLike))).toBe('invalid-scheme')
    })

    it('rejects other schemes', () => {
      expect(
        expectErr(
          parseSpaceUri(
            `https://${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}`,
          ),
        ),
      ).toBe('invalid-scheme')
      // Scheme is case-sensitive: "AT://" is not "at://".
      expect(
        expectErr(
          parseSpaceUri(
            `AT://${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}`,
          ),
        ),
      ).toBe('invalid-scheme')
    })
  })

  describe('space marker rejection', () => {
    it('rejects a missing marker (public-shaped space URI)', () => {
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}did:web:tokyo3.example.com/com.evangelion.type/rei`,
          ),
        ),
      ).toBe('invalid-space-marker')
    })

    it('rejects a marker in the wrong position', () => {
      // 4 components (the right count) but the marker is not the segment after
      // the authority.
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/${SPACE_SEGMENT}/${SKEY}`,
          ),
        ),
      ).toBe('invalid-space-marker')
    })

    it('rejects a public-shaped record URI in both parsers', () => {
      const publicUri = `${AT_SCHEME}did:plc:reikagami/com.evangelion.feed.post/3kabc`
      expect(expectErr(parseSpaceUri(publicUri))).toBe('invalid-space-marker')
      expect(expectErr(parseRecordUri(publicUri))).toBe('invalid-space-marker')
    })
  })

  describe('component-count rejection (marker present)', () => {
    it('rejects a space URI with the wrong number of components', () => {
      for (const n of [3, 5, 6, 8]) {
        expect(expectErr(parseSpaceUri(markerUriWithSegments(n)))).toBe(
          'invalid-component-count',
        )
      }
    })

    it('rejects a record URI with the wrong number of components', () => {
      for (const n of [3, 5, 6, 8]) {
        expect(expectErr(parseRecordUri(markerUriWithSegments(n)))).toBe(
          'invalid-component-count',
        )
      }
    })

    it('rejects the space form fed to the record parser and vice versa', () => {
      expect(expectErr(parseRecordUri(VALID_SPACE_URI))).toBe(
        'invalid-component-count',
      )
      expect(expectErr(parseSpaceUri(VALID_RECORD_URI))).toBe(
        'invalid-component-count',
      )
    })

    it('rejects trailing extra components', () => {
      expect(expectErr(parseSpaceUri(`${VALID_SPACE_URI}/extra`))).toBe(
        'invalid-component-count',
      )
      expect(expectErr(parseRecordUri(`${VALID_RECORD_URI}/extra`))).toBe(
        'invalid-component-count',
      )
    })
  })

  describe('parseSpaceUri component rejections', () => {
    it('rejects an empty / invalid space DID', () => {
      expect(
        expectErr(
          parseSpaceUri(`${AT_SCHEME}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}`),
        ),
      ).toBe('invalid-space-did')
    })

    it('rejects an invalid space type NSID', () => {
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/nope/${SKEY}`,
          ),
        ),
      ).toBe('invalid-space-type')
    })

    it('rejects a 513-byte skey', () => {
      const s513 = 'a'.repeat(513)
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${s513}`,
          ),
        ),
      ).toBe('invalid-skey')
    })

    it('rejects skey "." and ".."', () => {
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/.`,
          ),
        ),
      ).toBe('invalid-skey')
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/..`,
          ),
        ),
      ).toBe('invalid-skey')
    })

    it('rejects invalid skey characters', () => {
      // "%20" contains "%", which is not in the record-key alphabet.
      expect(
        expectErr(
          parseSpaceUri(
            `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/bad%20`,
          ),
        ),
      ).toBe('invalid-skey')
    })
  })

  describe('parseRecordUri component rejections', () => {
    it('rejects an empty author DID', () => {
      const uri = `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}//${COLLECTION}/3k2a`
      expect(expectErr(parseRecordUri(uri))).toBe('invalid-author-did')
    })

    it('rejects an invalid collection NSID', () => {
      const uri = `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}/${AUTHOR_DID}/nope/3k2a`
      expect(expectErr(parseRecordUri(uri))).toBe('invalid-collection')
    })

    it('rejects an invalid rkey', () => {
      const uri = `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}/${AUTHOR_DID}/${COLLECTION}/.`
      expect(expectErr(parseRecordUri(uri))).toBe('invalid-rkey')
    })
  })

  describe('format rejections (no exceptions on invalid input)', () => {
    it('formatSpaceUri rejects invalid parts without throwing', () => {
      expect(
        expectErr(
          formatSpaceUri({
            spaceDid: '',
            spaceType: SPACE_TYPE,
            skey: SKEY,
          }),
        ),
      ).toBe('invalid-space-did')
      expect(
        expectErr(
          formatSpaceUri({
            spaceDid: SERVICE_DID,
            spaceType: 'nope',
            skey: SKEY,
          }),
        ),
      ).toBe('invalid-space-type')
      expect(
        expectErr(
          formatSpaceUri({
            spaceDid: SERVICE_DID,
            spaceType: SPACE_TYPE,
            skey: '..',
          }),
        ),
      ).toBe('invalid-skey')
    })

    it('formatRecordUri rejects invalid parts without throwing', () => {
      const base: RecordUri = {
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: SKEY,
        authorDid: AUTHOR_DID,
        collection: COLLECTION,
        rkey: 'self',
      }
      expect(expectErr(formatRecordUri({ ...base, authorDid: '' }))).toBe(
        'invalid-author-did',
      )
      expect(expectErr(formatRecordUri({ ...base, rkey: '.' }))).toBe(
        'invalid-rkey',
      )
    })
  })

  describe('strict-equality semantics (no normalization)', () => {
    it('does not case-fold: differing byte-strings are different resources', () => {
      const lower = expectOk(
        formatSpaceUri({
          spaceDid: 'did:web:example.com',
          spaceType: SPACE_TYPE,
          skey: 'abc',
        }),
      )
      const upperSkey = expectOk(
        formatSpaceUri({
          spaceDid: 'did:web:example.com',
          spaceType: SPACE_TYPE,
          skey: 'ABC',
        }),
      )
      expect(lower).not.toBe(upperSkey)
    })

    it('preserves skey byte-for-byte through a round-trip', () => {
      const skey = 'aA0.:_~-'
      const uri = expectOk(
        formatSpaceUri({ spaceDid: SERVICE_DID, spaceType: SPACE_TYPE, skey }),
      )
      expect(expectOk(parseSpaceUri(uri)).skey).toBe(skey)
    })
  })

  describe('boundaryToSpaceUri', () => {
    it('maps a boundary to a space URI (serviceDid->spaceDid, domainName->skey)', () => {
      const uri = expectOk(
        boundaryToSpaceUri(`${SERVICE_DID}/${SKEY}`, SPACE_TYPE),
      )
      expect(uri).toBe(
        `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${SPACE_TYPE}/${SKEY}`,
      )
    })

    it('uses the caller-supplied spaceType and hardcodes nothing', () => {
      const other = 'zone.stratos.space.other'
      const uri = expectOk(boundaryToSpaceUri(`${SERVICE_DID}/nerv`, other))
      expect(uri).toBe(
        `${AT_SCHEME}${SERVICE_DID}/${SPACE_SEGMENT}/${other}/nerv`,
      )
    })

    it('produces the same string as formatSpaceUri for equivalent parts', () => {
      const viaBoundary = expectOk(
        boundaryToSpaceUri(`${SERVICE_DID}/${SKEY}`, SPACE_TYPE),
      )
      const viaFormat = expectOk(
        formatSpaceUri({
          spaceDid: SERVICE_DID,
          spaceType: SPACE_TYPE,
          skey: SKEY,
        }),
      )
      expect(viaBoundary).toBe(viaFormat)
    })

    it('rejects a boundary without a "/"', () => {
      expect(expectErr(boundaryToSpaceUri(SERVICE_DID, SPACE_TYPE))).toBe(
        'invalid-boundary',
      )
    })

    it('rejects a boundary with an invalid service DID', () => {
      expect(expectErr(boundaryToSpaceUri('notadid/pottery', SPACE_TYPE))).toBe(
        'invalid-space-did',
      )
    })

    it('rejects a boundary whose domainName is not a valid skey', () => {
      expect(
        expectErr(boundaryToSpaceUri(`${SERVICE_DID}/bad name`, SPACE_TYPE)),
      ).toBe('invalid-skey')
      // Empty domainName (trailing slash).
      expect(expectErr(boundaryToSpaceUri(`${SERVICE_DID}/`, SPACE_TYPE))).toBe(
        'invalid-skey',
      )
    })

    it('rejects an invalid spaceType parameter', () => {
      expect(
        expectErr(boundaryToSpaceUri(`${SERVICE_DID}/${SKEY}`, 'nope')),
      ).toBe('invalid-space-type')
    })
  })

  describe('spaceUriToBoundary', () => {
    it('maps a space URI back to a boundary', () => {
      const boundary = expectOk(
        spaceUriToBoundary(VALID_SPACE_URI, SERVICE_DID),
      )
      expect(boundary).toBe(`${SERVICE_DID}/${SKEY}`)
    })

    it('round-trips with boundaryToSpaceUri', () => {
      const boundary = `${SERVICE_DID}/${SKEY}`
      const uri = expectOk(boundaryToSpaceUri(boundary, SPACE_TYPE))
      expect(expectOk(spaceUriToBoundary(uri, SERVICE_DID))).toBe(boundary)
    })

    it('errors on a mismatched service DID', () => {
      expect(
        expectErr(
          spaceUriToBoundary(VALID_SPACE_URI, 'did:web:other.example.com'),
        ),
      ).toBe('service-did-mismatch')
    })

    it('does not treat a byte-different-but-similar DID as a match (strict equality)', () => {
      // Same DID with different case is NOT equal.
      const uri = expectOk(
        formatSpaceUri({
          spaceDid: 'did:web:example.com',
          spaceType: SPACE_TYPE,
          skey: 'abc',
        }),
      )
      expect(expectErr(spaceUriToBoundary(uri, 'did:web:Example.com'))).toBe(
        'service-did-mismatch',
      )
    })

    it('propagates parse errors for a malformed URI', () => {
      // Retired scheme surfaces as invalid-scheme.
      expect(
        expectErr(
          spaceUriToBoundary(`ats://x/${SPACE_SEGMENT}/y/z`, SERVICE_DID),
        ),
      ).toBe('invalid-scheme')
      // Missing marker surfaces as invalid-space-marker.
      expect(
        expectErr(spaceUriToBoundary(`${AT_SCHEME}x/y/z`, SERVICE_DID)),
      ).toBe('invalid-space-marker')
    })
  })
})
