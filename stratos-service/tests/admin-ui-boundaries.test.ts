import { describe, expect, it } from 'vitest'
import { boundaryName } from '../admin-ui/src/lib/boundaries'

describe('boundaryName', () => {
  it('returns the trailing name of a service-qualified boundary', () => {
    expect(boundaryName('did:web:nerv.tokyo.jp/general')).toBe('general')
  })

  it('keeps a name that carries no service prefix', () => {
    expect(boundaryName('general')).toBe('general')
  })

  it('uses the last separator so a did:web port survives', () => {
    expect(boundaryName('did:web:localhost%3A3100/swordsmith')).toBe(
      'swordsmith',
    )
  })

  it('falls back to the input when the value ends in a separator', () => {
    expect(boundaryName('did:web:nerv.tokyo.jp/')).toBe(
      'did:web:nerv.tokyo.jp/',
    )
  })

  it('handles an empty string', () => {
    expect(boundaryName('')).toBe('')
  })
})
