import { describe, expect, it } from 'vitest'
import {
  ATS_SCHEME,
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

const SERVICE_DID = 'did:web:stratos.example.com'
const AUTHOR_DID = 'did:plc:abc123xyz'
const SPACE_TYPE = 'zone.stratos.space.pottery'
const COLLECTION = 'app.bsky.feed.post'

const VALID_SPACE_URI = `${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery`
const VALID_RECORD_URI = `${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery/${AUTHOR_DID}/${COLLECTION}/3k2a`

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
  })

  describe('isSyntacticDid', () => {
    it('accepts well-formed DIDs', () => {
      expect(isSyntacticDid('did:plc:abc123')).toBe(true)
      expect(isSyntacticDid('did:web:stratos.example.com')).toBe(true)
    })

    it('rejects empty / malformed DIDs', () => {
      expect(isSyntacticDid('')).toBe(false)
      expect(isSyntacticDid('did:plc:')).toBe(false)
      expect(isSyntacticDid('did:')).toBe(false)
      expect(isSyntacticDid('notadid')).toBe(false)
      // DIDs cannot contain "/", so a boundary string is not a DID.
      expect(isSyntacticDid('did:web:stratos.example.com/pottery')).toBe(false)
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
        skey: 'pottery',
      } satisfies SpaceUri)
      const reformatted = expectOk(formatSpaceUri(parts))
      expect(reformatted).toBe(VALID_SPACE_URI)
    })

    it('format then parse yields the same parts', () => {
      const parts: SpaceUri = {
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: 'engineering',
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
        skey: 'pottery',
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
        skey: 'pottery',
        authorDid: AUTHOR_DID,
        collection: COLLECTION,
        rkey: 'self',
      }
      const uri = expectOk(formatRecordUri(parts))
      expect(expectOk(parseRecordUri(uri))).toEqual(parts)
    })
  })

  describe('parseSpaceUri rejections', () => {
    it('rejects the wrong scheme', () => {
      expect(expectErr(parseSpaceUri(`at://${SERVICE_DID}/${SPACE_TYPE}/pottery`))).toBe(
        'invalid-scheme',
      )
      expect(expectErr(parseSpaceUri(`https://${SERVICE_DID}/${SPACE_TYPE}/pottery`))).toBe(
        'invalid-scheme',
      )
      // Case-sensitive scheme: "ATS://" is not "ats://".
      expect(expectErr(parseSpaceUri(`ATS://${SERVICE_DID}/${SPACE_TYPE}/pottery`))).toBe(
        'invalid-scheme',
      )
    })

    it('rejects too few components', () => {
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}`))).toBe(
        'invalid-component-count',
      )
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}`))).toBe(
        'invalid-component-count',
      )
    })

    it('rejects too many components', () => {
      expect(
        expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery/extra`)),
      ).toBe('invalid-component-count')
    })

    it('rejects an empty / invalid space DID', () => {
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}/${SPACE_TYPE}/pottery`))).toBe(
        'invalid-space-did',
      )
    })

    it('rejects an invalid space type NSID', () => {
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/nope/pottery`))).toBe(
        'invalid-space-type',
      )
    })

    it('rejects a 513-byte skey', () => {
      const s513 = 'a'.repeat(513)
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/${s513}`))).toBe(
        'invalid-skey',
      )
    })

    it('rejects skey "." and ".."', () => {
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/.`))).toBe(
        'invalid-skey',
      )
      // ".." collapses to 3 components: spaceDid/spaceType/"..".
      expect(expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/..`))).toBe(
        'invalid-skey',
      )
    })

    it('rejects invalid skey characters', () => {
      // "%20" contains "%", which is not in the record-key alphabet.
      expect(
        expectErr(parseSpaceUri(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/bad%20`)),
      ).toBe('invalid-skey')
    })
  })

  describe('parseRecordUri rejections', () => {
    it('rejects too few components', () => {
      expect(expectErr(parseRecordUri(VALID_SPACE_URI))).toBe('invalid-component-count')
    })

    it('rejects too many components', () => {
      expect(expectErr(parseRecordUri(`${VALID_RECORD_URI}/extra`))).toBe(
        'invalid-component-count',
      )
    })

    it('rejects an empty author DID', () => {
      const uri = `${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery//${COLLECTION}/3k2a`
      expect(expectErr(parseRecordUri(uri))).toBe('invalid-author-did')
    })

    it('rejects an invalid collection NSID', () => {
      const uri = `${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery/${AUTHOR_DID}/nope/3k2a`
      expect(expectErr(parseRecordUri(uri))).toBe('invalid-collection')
    })

    it('rejects an invalid rkey', () => {
      const uri = `${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery/${AUTHOR_DID}/${COLLECTION}/.`
      expect(expectErr(parseRecordUri(uri))).toBe('invalid-rkey')
    })
  })

  describe('format rejections (no exceptions on invalid input)', () => {
    it('formatSpaceUri rejects invalid parts without throwing', () => {
      expect(
        expectErr(formatSpaceUri({ spaceDid: '', spaceType: SPACE_TYPE, skey: 'pottery' })),
      ).toBe('invalid-space-did')
      expect(
        expectErr(
          formatSpaceUri({ spaceDid: SERVICE_DID, spaceType: 'nope', skey: 'pottery' }),
        ),
      ).toBe('invalid-space-type')
      expect(
        expectErr(formatSpaceUri({ spaceDid: SERVICE_DID, spaceType: SPACE_TYPE, skey: '..' })),
      ).toBe('invalid-skey')
    })

    it('formatRecordUri rejects invalid parts without throwing', () => {
      const base: RecordUri = {
        spaceDid: SERVICE_DID,
        spaceType: SPACE_TYPE,
        skey: 'pottery',
        authorDid: AUTHOR_DID,
        collection: COLLECTION,
        rkey: 'self',
      }
      expect(expectErr(formatRecordUri({ ...base, authorDid: '' }))).toBe('invalid-author-did')
      expect(expectErr(formatRecordUri({ ...base, rkey: '.' }))).toBe('invalid-rkey')
    })
  })

  describe('strict-equality semantics (no normalization)', () => {
    it('does not case-fold: differing byte-strings are different resources', () => {
      const lower = expectOk(
        formatSpaceUri({ spaceDid: 'did:web:example.com', spaceType: SPACE_TYPE, skey: 'abc' }),
      )
      const upperSkey = expectOk(
        formatSpaceUri({ spaceDid: 'did:web:example.com', spaceType: SPACE_TYPE, skey: 'ABC' }),
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
    it('maps a boundary to a space URI (scheme A: serviceDid->spaceDid, domainName->skey)', () => {
      const uri = expectOk(boundaryToSpaceUri(`${SERVICE_DID}/pottery`, SPACE_TYPE))
      expect(uri).toBe(`${ATS_SCHEME}${SERVICE_DID}/${SPACE_TYPE}/pottery`)
    })

    it('uses the caller-supplied spaceType and hardcodes nothing', () => {
      const other = 'zone.stratos.space.other'
      const uri = expectOk(boundaryToSpaceUri(`${SERVICE_DID}/eng`, other))
      expect(uri).toBe(`${ATS_SCHEME}${SERVICE_DID}/${other}/eng`)
    })

    it('rejects a boundary without a "/"', () => {
      expect(expectErr(boundaryToSpaceUri(SERVICE_DID, SPACE_TYPE))).toBe('invalid-boundary')
    })

    it('rejects a boundary with an invalid service DID', () => {
      expect(expectErr(boundaryToSpaceUri('notadid/pottery', SPACE_TYPE))).toBe(
        'invalid-space-did',
      )
    })

    it('rejects a boundary whose domainName is not a valid skey', () => {
      expect(expectErr(boundaryToSpaceUri(`${SERVICE_DID}/bad name`, SPACE_TYPE))).toBe(
        'invalid-skey',
      )
      // Empty domainName (trailing slash).
      expect(expectErr(boundaryToSpaceUri(`${SERVICE_DID}/`, SPACE_TYPE))).toBe('invalid-skey')
    })

    it('rejects an invalid spaceType parameter', () => {
      expect(expectErr(boundaryToSpaceUri(`${SERVICE_DID}/pottery`, 'nope'))).toBe(
        'invalid-space-type',
      )
    })
  })

  describe('spaceUriToBoundary', () => {
    it('maps a space URI back to a boundary', () => {
      const boundary = expectOk(spaceUriToBoundary(VALID_SPACE_URI, SERVICE_DID))
      expect(boundary).toBe(`${SERVICE_DID}/pottery`)
    })

    it('round-trips with boundaryToSpaceUri', () => {
      const boundary = `${SERVICE_DID}/pottery`
      const uri = expectOk(boundaryToSpaceUri(boundary, SPACE_TYPE))
      expect(expectOk(spaceUriToBoundary(uri, SERVICE_DID))).toBe(boundary)
    })

    it('errors on a mismatched service DID', () => {
      expect(expectErr(spaceUriToBoundary(VALID_SPACE_URI, 'did:web:other.example.com'))).toBe(
        'service-did-mismatch',
      )
    })

    it('does not treat a byte-different-but-similar DID as a match (strict equality)', () => {
      // Same DID with different case is NOT equal.
      const uri = expectOk(
        formatSpaceUri({ spaceDid: 'did:web:example.com', spaceType: SPACE_TYPE, skey: 'abc' }),
      )
      expect(expectErr(spaceUriToBoundary(uri, 'did:web:Example.com'))).toBe(
        'service-did-mismatch',
      )
    })

    it('propagates parse errors for a malformed URI', () => {
      expect(expectErr(spaceUriToBoundary('at://x/y/z', SERVICE_DID))).toBe('invalid-scheme')
    })
  })
})
