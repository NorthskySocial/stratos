import { describe, it, expect } from 'vitest'
import { selectEnrollBoundaries } from '../src/oauth/routes.js'

describe('selectEnrollBoundaries', () => {
  const allDomains = ['posters-madness', 'bees', 'plants']

  it('should use autoEnrollDomains when provided and non-empty', () => {
    const result = selectEnrollBoundaries(['posters-madness'], allDomains)
    expect(result).toEqual(['posters-madness'])
  })

  it('should fall back to defaultBoundaries when autoEnrollDomains is undefined', () => {
    const result = selectEnrollBoundaries(undefined, allDomains)
    expect(result).toEqual(allDomains)
  })

  it('should fall back to defaultBoundaries when autoEnrollDomains is empty', () => {
    const result = selectEnrollBoundaries([], allDomains)
    expect(result).toEqual(allDomains)
  })

  it('should support multiple autoEnrollDomains', () => {
    const result = selectEnrollBoundaries(
      ['posters-madness', 'bees'],
      allDomains,
    )
    expect(result).toEqual(['posters-madness', 'bees'])
  })

  it('should return empty array when both are empty', () => {
    const result = selectEnrollBoundaries([], [])
    expect(result).toEqual([])
  })
})
