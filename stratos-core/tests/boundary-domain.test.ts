import { describe, expect, it } from 'vitest'
import {
  BoundaryManagementError,
  qualifyNewBoundary,
  validateBoundarySettings,
  type BoundarySettings,
} from '../src/boundary/index.js'
const settings: BoundarySettings = {
  displayName: 'Bebop',
  description: 'Crew only',
  listed: true,
  joinable: true,
  autoEnroll: false,
  appAccess: 'open',
  clientIds: [],
}
describe('boundary definition rules', () => {
  it('qualifies a valid immutable name and accepts the maximum name length', () => {
    expect(qualifyNewBoundary('did:web:bebop.example', 'crew')).toBe(
      'did:web:bebop.example/crew',
    )
    expect(qualifyNewBoundary('did:web:bebop.example', 'a'.repeat(128))).toBe(
      `did:web:bebop.example/${'a'.repeat(128)}`,
    )
    expect(() =>
      qualifyNewBoundary('did:web:bebop.example', 'a'.repeat(129)),
    ).toThrow('Use a bare boundary name of at most 128 characters')
  })
  it.each(['', 'a/b', '.', '..', 'a b'])('rejects invalid names %s', (name) => {
    expect(() => qualifyNewBoundary('did:web:bebop.example', name)).toThrow(
      'Use a valid boundary name',
    )
  })
  it('preserves stable domain error codes and messages', () => {
    const error = new BoundaryManagementError(
      'Bebop changed',
      'BoundaryConflict',
    )
    expect(error.message).toBe('Bebop changed')
    expect(error.code).toBe('BoundaryConflict')
  })
  it.each([
    { displayName: '' },
    { displayName: ' ' },
    { displayName: 'a'.repeat(121) },
    { description: 'a'.repeat(2001) },
  ])('bounds required display metadata %j', (change) => {
    expect(() => validateBoundarySettings({ ...settings, ...change })).toThrow(
      'Provide a name up to 120 characters and a description up to 2000 characters',
    )
  })
  it('accepts maximum metadata lengths and an empty optional description', () => {
    expect(() =>
      validateBoundarySettings({
        ...settings,
        displayName: 'a'.repeat(120),
        description: 'a'.repeat(2000),
      }),
    ).not.toThrow()
    expect(() =>
      validateBoundarySettings({
        ...settings,
        displayName: 'F',
        description: '',
      }),
    ).not.toThrow()
  })
  it('requires an explicit access policy and a nonempty allow-list', () => {
    expect(() =>
      validateBoundarySettings({ ...settings, appAccess: 'unknown' as 'open' }),
    ).toThrow('Choose an application access policy')
    expect(() =>
      validateBoundarySettings({ ...settings, appAccess: 'allowList' }),
    ).toThrow('Add at least one allowed application')
    expect(() =>
      validateBoundarySettings({
        ...settings,
        appAccess: 'allowList',
        clientIds: ['https://bebop.example/client.json'],
      }),
    ).not.toThrow()
  })
  it.each([
    'garbage',
    'http://bebop.example',
    'https://spike:secret@bebop.example',
    'https://:secret@bebop.example',
    'https://spike@bebop.example',
    'https://bebop.example/#fragment',
  ])('rejects unsuitable client IDs %s', (id) => {
    expect(() =>
      validateBoundarySettings({ ...settings, clientIds: [id] }),
    ).toThrow(
      'Application IDs must be HTTPS URLs without credentials or fragments',
    )
  })
  it('bounds allowed applications and permits HTTPS query parameters', () => {
    expect(() =>
      validateBoundarySettings({
        ...settings,
        clientIds: Array(101).fill('https://bebop.example'),
      }),
    ).toThrow(
      'Application IDs must be HTTPS URLs without credentials or fragments',
    )
    expect(() =>
      validateBoundarySettings({
        ...settings,
        clientIds: Array(100).fill('https://bebop.example/client?version=1'),
      }),
    ).not.toThrow()
  })
  it('reports InvalidRequest for every rejected input category', () => {
    const actions = [
      () => qualifyNewBoundary('did:web:bebop.example',''),
      () => qualifyNewBoundary('did:web:bebop.example','a'.repeat(129)),
      () => validateBoundarySettings({...settings,displayName:''}),
      () => validateBoundarySettings({...settings,appAccess:'invalid' as 'open'}),
      () => validateBoundarySettings({...settings,appAccess:'allowList'}),
      () => validateBoundarySettings({...settings,clientIds:['http://bebop.example']}),
    ]
    for (const action of actions) {
      try { action(); expect.fail('invalid input accepted') }
      catch (error) { expect(error).toMatchObject({code:'InvalidRequest'}) }
    }
  })

})
