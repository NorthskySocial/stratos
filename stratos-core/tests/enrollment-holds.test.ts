import { describe, expect, it } from 'vitest'
import { computeEnrollmentActive } from '../src/index.js'

describe('computeEnrollmentActive', () => {
  it.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false],
  ])(
    'operatorHold %s and takedownHold %s gives active %s',
    (operatorHold, takedownHold, expected) => {
      expect(computeEnrollmentActive({ operatorHold, takedownHold })).toBe(
        expected,
      )
    },
  )
})
