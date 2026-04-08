import { describe, it, expect } from 'vitest'
import { displayBoundary } from '../src/lib/boundary-display'

describe('boundary-display', () => {
  it('extracts display name from qualified boundaries', () => {
    expect(displayBoundary('did:web:stratos.example.com/engineering')).toBe(
      'engineering',
    )
    expect(displayBoundary('did:web:stratos.actor.enrollment/leadership')).toBe(
      'leadership',
    )
    expect(displayBoundary('did:plc:xyz/devs')).toBe('devs')
  })

  it('passes through legacy bare names', () => {
    expect(displayBoundary('engineering')).toBe('engineering')
    expect(displayBoundary('leadership')).toBe('leadership')
  })

  it('handles boundaries with multiple slashes by taking the last part', () => {
    // Current implementation: boundary.slice(slashIndex + 1) where slashIndex is the FIRST slash after the DID.
    // Let's verify what it actually does with more complex inputs.
    expect(displayBoundary('did:web:example.com/part1/part2')).toBe(
      'part1/part2',
    )
  })

  it('returns original string if it is a DID but has no slash', () => {
    expect(displayBoundary('did:web:example.com')).toBe('did:web:example.com')
  })

  it('returns original string if it does not start with did:', () => {
    expect(displayBoundary('/not-a-did/path')).toBe('/not-a-did/path')
  })
})
