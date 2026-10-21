import { describe, expect, it } from 'vitest'
import {
  createSettingsPreview,
  settingsPreviewMatches,
  boundaryDetailHref,
  boundaryDraftChanged,
  parseBoundarySelection,
  createMembershipPreview,
  getMembershipAvailability,
  membershipPreviewMatches,
} from '../src/lib/boundary-workspace'

describe('boundary workspace', () => {
  const saved = {
    name: 'pilots',
    displayName: 'Pilots',
    description: '',
    listed: false,
    joinable: false,
    autoEnroll: false,
    appAccess: 'open' as const,
    clientIdsText: '',
  }
  const boundary = {
    boundary: 'did:web:nerv.test/pilots',
    roomId: 'pilots',
    revision: 4,
    displayName: 'Pilots',
    description: 'Saved',
    listed: true,
    joinable: true,
    autoEnroll: true,
    appAccess: 'allowList' as const,
    clientIds: ['https://rei.test/client'],
    status: 'active' as const,
    memberCount: 2,
    reserved: false,
    createdAt: '1995-10-04T00:00:00Z',
    updatedAt: '1995-10-04T00:00:00Z',
  }
  it('captures every converted field and saved value without rebasing', () => {
    const draft = {
      ...saved,
      displayName: '  Misato  ',
      description: 'Draft',
      clientIdsText: 'https://unused.test/client',
    }
    const preview = createSettingsPreview(draft, boundary)
    expect(preview).toEqual({
      boundary: boundary.boundary,
      revision: 4,
      rawDraft: JSON.stringify(draft),
      before: {
        displayName: 'Pilots',
        description: 'Saved',
        listed: true,
        joinable: true,
        autoEnroll: true,
        appAccess: 'allowList',
        clientIds: ['https://rei.test/client'],
      },
      settings: {
        displayName: 'Misato',
        description: 'Draft',
        listed: false,
        joinable: false,
        autoEnroll: false,
        appAccess: 'open',
        clientIds: [],
      },
    })
    expect(settingsPreviewMatches(preview, draft, boundary)).toBe(true)
    expect(
      settingsPreviewMatches(
        preview,
        { ...draft, displayName: 'Misato' },
        boundary,
      ),
    ).toBe(false)
    expect(
      settingsPreviewMatches(preview, draft, { ...boundary, revision: 5 }),
    ).toBe(false)
    expect(
      settingsPreviewMatches(preview, draft, {
        ...boundary,
        boundary: 'other',
      }),
    ).toBe(false)
    draft.description = 'Later'
    boundary.clientIds.push('https://asuka.test/client')
    expect(preview.settings.description).toBe('Draft')
    expect(preview.before.clientIds).toEqual(['https://rei.test/client'])
    boundary.clientIds.pop()
  })
  it('uses the existing allowlist conversion', () => {
    expect(
      createSettingsPreview(
        {
          ...saved,
          appAccess: 'allowList',
          clientIdsText:
            ' https://rei.test/client \n\nhttps://asuka.test/client ',
        },
        boundary,
      ).settings.clientIds,
    ).toEqual(['https://rei.test/client', 'https://asuka.test/client'])
  })
  it('does not guard an unchanged draft', () => {
    expect(boundaryDraftChanged({ ...saved }, saved)).toBe(false)
  })
  it.each(Object.keys(saved) as (keyof typeof saved)[])(
    'protects raw changes to %s',
    (key) => {
      const draft = {
        ...saved,
        [key]: typeof saved[key] === 'boolean' ? !saved[key] : `${saved[key]} `,
      }
      expect(boundaryDraftChanged(draft, saved)).toBe(true)
    },
  )
})

describe('boundary workspace membership contract', () => {
  const snapshot = (
    overrides: Partial<{
      status: 'active' | 'deactivating' | 'inactive'
      reserved: boolean
      enrolled: boolean
      active: boolean
      boundaries: string[]
      uncertainBoundaries: string[]
    }> = {},
  ) => ({
    lookupIdentity: 'did:plc:rei',
    boundary: {
      boundary: 'did:web:nerv.test/engineering',
      revision: 4,
      status: overrides.status ?? 'active',
      reserved: overrides.reserved ?? false,
    },
    enrollment: {
      did: 'did:plc:rei',
      enrolled: overrides.enrolled ?? true,
      active: overrides.active ?? true,
      boundaries: overrides.boundaries ?? [],
      uncertainBoundaries: overrides.uncertainBoundaries ?? [],
    },
  })

  it.each([
    [{}, { type: 'add' }, { available: true }],
    [
      { boundaries: ['did:web:nerv.test/engineering'] },
      { type: 'add' },
      { available: false, reason: 'already-member' },
    ],
    [{}, { type: 'remove' }, { available: false, reason: 'not-member' }],
    [
      { boundaries: ['did:web:nerv.test/engineering'] },
      { type: 'remove' },
      { available: true },
    ],
    [
      { status: 'inactive' },
      { type: 'add' },
      { available: false, reason: 'boundary-not-active' },
    ],
    [
      { status: 'deactivating' },
      { type: 'add' },
      { available: false, reason: 'boundary-not-active' },
    ],
    [
      { status: 'inactive', boundaries: ['did:web:nerv.test/engineering'] },
      { type: 'remove' },
      { available: true },
    ],
    [
      { status: 'deactivating', boundaries: ['did:web:nerv.test/engineering'] },
      { type: 'remove' },
      { available: true },
    ],
    [
      { reserved: true, boundaries: ['did:web:nerv.test/engineering'] },
      { type: 'remove' },
      { available: false, reason: 'reserved-boundary' },
    ],
    [
      { enrolled: false },
      { type: 'add' },
      { available: false, reason: 'unenrolled' },
    ],
    [
      { enrolled: false, boundaries: ['did:web:nerv.test/engineering'] },
      { type: 'remove' },
      { available: false, reason: 'unenrolled' },
    ],
  ] as const)('availability for %j %j', (overrides, operation, expected) => {
    expect(getMembershipAvailability(operation, snapshot(overrides))).toEqual(
      expected,
    )
  })

  it('rejects a lookup identity that does not match the enrollment DID', () => {
    const mismatched = {
      ...snapshot(),
      lookupIdentity: 'did:plc:asuka',
    }
    expect(getMembershipAvailability({ type: 'add' }, mismatched)).toEqual({
      available: false,
      reason: 'target-mismatch',
    })
    expect(createMembershipPreview({ type: 'add' }, mismatched)).toBeNull()
  })

  it('rejects a target DID that differs from the confirmed lookup identity', () => {
    const mismatched = {
      ...snapshot(),
      enrollment: { ...snapshot().enrollment, did: 'did:plc:asuka' },
    }
    expect(getMembershipAvailability({ type: 'add' }, mismatched)).toEqual({
      available: false,
      reason: 'target-mismatch',
    })
    expect(createMembershipPreview({ type: 'add' }, mismatched)).toBeNull()
  })

  it('allows an inactive enrollment to receive a boundary without changing activation', () => {
    const current = snapshot({ active: false })
    expect(getMembershipAvailability({ type: 'add' }, current)).toEqual({
      available: true,
    })
    expect(createMembershipPreview({ type: 'add' }, current)).toMatchObject({
      targetDid: 'did:plc:rei',
      boundary: 'did:web:nerv.test/engineering',
      active: false,
      wasMember: false,
    })
  })

  it('matches only the selected membership and invalidates every relevant snapshot field', () => {
    const original = snapshot({ boundaries: ['did:web:nerv.test/leadership'] })
    const preview = createMembershipPreview({ type: 'add' }, original)
    expect(preview).not.toBeNull()
    if (!preview) throw new Error('Expected an available membership preview')
    expect(
      membershipPreviewMatches(
        preview,
        snapshot({
          boundaries: [
            'did:web:nerv.test/leadership',
            'did:web:nerv.test/research',
          ],
        }),
      ),
    ).toBe(true)
    expect(
      membershipPreviewMatches(
        preview,
        snapshot({
          status: 'inactive',
          boundaries: original.enrollment.boundaries,
        }),
      ),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        lookupIdentity: 'did:plc:asuka',
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        enrollment: { ...original.enrollment, did: 'did:plc:asuka' },
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        enrollment: { ...original.enrollment, active: false },
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        boundary: {
          ...original.boundary,
          boundary: 'did:web:nerv.test/research',
        },
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        boundary: { ...original.boundary, revision: 5 },
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        boundary: { ...original.boundary, reserved: true },
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        enrollment: { ...original.enrollment, enrolled: false },
      }),
    ).toBe(false)
    expect(
      membershipPreviewMatches(preview, {
        ...original,
        enrollment: {
          ...original.enrollment,
          boundaries: ['did:web:nerv.test/engineering'],
        },
      }),
    ).toBe(false)
  })

  it('accepts a snapshot without optional uncertainty metadata', () => {
    const current = snapshot()
    const enrollment = {
      did: current.enrollment.did,
      enrolled: true,
      active: true,
      boundaries: [],
    }
    expect(
      getMembershipAvailability({ type: 'add' }, { ...current, enrollment }),
    ).toEqual({ available: true })
  })

  it('blocks only the explicitly uncertain boundary in the enrollment snapshot', () => {
    const boundary = 'did:web:nerv.test/engineering'
    expect(
      getMembershipAvailability(
        { type: 'add' },
        snapshot({ uncertainBoundaries: [boundary] }),
      ),
    ).toEqual({ available: false, reason: 'reconciliation-required' })
    expect(
      getMembershipAvailability(
        { type: 'add' },
        snapshot({ uncertainBoundaries: ['did:web:nerv.test/research'] }),
      ),
    ).toEqual({ available: true })
  })
})

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
