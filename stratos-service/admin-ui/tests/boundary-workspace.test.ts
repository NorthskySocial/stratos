import { describe, expect, it } from 'vitest'
import {
  boundaryDetailHref,
  parseBoundarySelection,
} from '../src/lib/boundary-workspace'

describe('boundary workspace route contract', () => {
  it('preserves a full service-qualified boundary identifier', () => {
    const boundary = 'did:web:nerv.test/engineering/ops'
    expect(
      parseBoundarySelection(
        `?boundary=${encodeURIComponent(boundary)}&tab=overview`,
      ),
    ).toEqual({
      boundary,
      tab: 'overview',
      valid: true,
    })
  })

  it('round trips literal percent characters without decoding twice', () => {
    const boundary = 'did:web:nerv.test/100% ready'
    const href = boundaryDetailHref(boundary)
    expect(parseBoundarySelection(href.split('?')[1])).toMatchObject({
      boundary,
      valid: true,
    })
    expect(parseBoundarySelection(href.split('?')[1]).tab).toBe('overview')
    expect(boundaryDetailHref(boundary)).toContain('tab=overview')
    expect(boundaryDetailHref('did:web:nerv.test/ops', 'members')).toContain(
      'tab=members',
    )
  })

  it.each(['', 'boundary=', 'boundary=one&boundary=two'])(
    'rejects ambiguous or missing identifiers: %s',
    (query) => expect(parseBoundarySelection(query).valid).toBe(false),
  )

  it('rejects a missing boundary even when a valid tab is present', () => {
    expect(parseBoundarySelection('tab=overview')).toEqual({
      boundary: null,
      tab: 'overview',
      valid: false,
    })
  })

  it('preserves encoded percent characters without decoding them twice', () => {
    expect(parseBoundarySelection('boundary=100%25%20ready')).toMatchObject({
      boundary: '100% ready',
      valid: true,
    })
  })

  it('removes exactly one leading query marker', () => {
    expect(
      parseBoundarySelection('?boundary=did%3Aweb%3Anerv.test%2Fops').valid,
    ).toBe(true)
    expect(
      parseBoundarySelection('??boundary=did%3Aweb%3Anerv.test%2Fops').valid,
    ).toBe(true)
  })

  it.each(['%FF', '%E0%A4'])('rejects invalid UTF-8 escapes: %s', (value) => {
    expect(parseBoundarySelection(`boundary=${value}`).valid).toBe(false)
  })

  it.each([
    'boundary=valid&other=%FF',
    'boundary=valid&tab=%E0%A4',
    'boundary=valid&other=%',
  ])('rejects malformed escapes anywhere in the query: %s', (query) => {
    expect(parseBoundarySelection(query)).toEqual({
      boundary: null,
      tab: 'overview',
      valid: false,
    })
  })

  it.each(['boundary=a=b', 'boundary=a%3Db', 'boundary=a%26b'])(
    'preserves equals and separators inside values: %s',
    (query) => {
      expect(parseBoundarySelection(query)).toMatchObject({
        boundary: query
          .slice('boundary='.length)
          .replaceAll('%3D', '=')
          .replaceAll('%26', '&'),
        valid: true,
      })
    },
  )

  it('ignores unkeyed query parts while validating their encoding', () => {
    expect(parseBoundarySelection('unkeyed&boundary=valid')).toMatchObject({
      boundary: 'valid',
      valid: true,
    })
    expect(parseBoundarySelection('unkeyed%FF&boundary=valid').valid).toBe(
      false,
    )
  })

  it.each(['%FF', '%E0%A4', '%'])(
    'rejects malformed encoded values: %s',
    (value) => {
      expect(
        parseBoundarySelection(`boundary=valid&other=${value}`).valid,
      ).toBe(false)
    },
  )

  it('rejects duplicate keys after percent decoding', () => {
    expect(parseBoundarySelection('boundary=one&%62oundary=two').valid).toBe(
      false,
    )
  })

  it('accepts plus in raw query fields as valid ASCII', () => {
    expect(parseBoundarySelection('boundary=a+b&tab=members')).toMatchObject({
      boundary: 'a b',
      tab: 'members',
      valid: true,
    })
  })

  it.each(['%FF', '%E0%A4', '%'])(
    'rejects malformed encoded parameter names: %s',
    (name) => {
      expect(parseBoundarySelection(`${name}=value&boundary=valid`).valid).toBe(
        false,
      )
    },
  )

  it('recognizes an encoded valid boundary parameter name', () => {
    expect(parseBoundarySelection('%62oundary=valid')).toMatchObject({
      boundary: 'valid',
      valid: true,
    })
  })

  it('rejects malformed percent escapes', () => {
    expect(parseBoundarySelection('boundary=%E0%A4%A').valid).toBe(false)
    expect(
      parseBoundarySelection('boundary=did%3Aweb%3Anerv.test%2Fops%').valid,
    ).toBe(false)
    expect(
      parseBoundarySelection('boundary=did%3Aweb%3Anerv.test%2Fops%').tab,
    ).toBe('overview')
  })

  it.each(['', 'future', 'OVERVIEW'])(
    'defaults unknown tab %s to overview',
    (tab) =>
      expect(
        parseBoundarySelection(
          `boundary=did%3Aweb%3Anerv.test%2Fops&tab=${tab}`,
        ).tab,
      ).toBe('overview'),
  )

  it('accepts known non-overview values for safe intermediate fallback', () => {
    expect(
      parseBoundarySelection('boundary=did%3Aweb%3Anerv.test%2Fops&tab=members')
        .tab,
    ).toBe('members')
    expect(
      parseBoundarySelection(
        'boundary=did%3Aweb%3Anerv.test%2Fops&tab=settings',
      ).tab,
    ).toBe('settings')
  })
})
