import { describe, expect, it } from 'vitest'
import {
  SCALE_ACTOR_COUNT,
  SCALE_POST_COUNT,
  SMALL_ACTOR_COUNT,
  SMALL_BOUNDARY_COUNT,
  SMALL_POST_COUNT,
  countPostsByBoundary,
  createScaleOracleFixture,
  createSmallOracleFixture,
  expectedPostsForBoundary,
  fingerprintFixture,
} from './oracle.js'

describe('feedgen oracle fixtures', () => {
  it('keeps the small profile deterministic and balanced', () => {
    const fixture = createSmallOracleFixture()

    expect(fixture.actors).toHaveLength(SMALL_ACTOR_COUNT)
    expect(fixture.boundaries).toHaveLength(SMALL_BOUNDARY_COUNT)
    expect(fixture.posts).toHaveLength(SMALL_POST_COUNT)
    expect(new Set(Object.values(fixture.custodyByActor))).toEqual(
      new Set(['stratos', 'pds']),
    )
    expect(countPostsByBoundary(fixture)).toEqual({
      'boundary-1': 2_000,
      'boundary-2': 2_000,
      'boundary-3': 2_000,
      'boundary-4': 2_000,
      'boundary-5': 2_000,
    })
    expect(expectedPostsForBoundary(fixture, 'boundary-3')).toHaveLength(2_000)
    expect(fingerprintFixture(fixture)).toBe(
      '447e9f05c6e9bdcde0d7a4230d2d946ee4b7cc8fc4d0ff508367e7b75a8592a9',
    )
  })

  it('provides a deterministic capacity fixture', () => {
    const fixture = createScaleOracleFixture()

    expect(fixture.actors).toHaveLength(SCALE_ACTOR_COUNT)
    expect(fixture.posts).toHaveLength(SCALE_POST_COUNT)
    expect(countPostsByBoundary(fixture)).toEqual({
      'boundary-1': 20_000,
      'boundary-2': 20_000,
      'boundary-3': 20_000,
      'boundary-4': 20_000,
      'boundary-5': 20_000,
    })
    expect(expectedPostsForBoundary(fixture, 'boundary-3')).toHaveLength(20_000)
    expect(fingerprintFixture(fixture)).toBe(
      '01f5bf39a754b3fbd9ea6624e02244ffd6e42d7b8f6f821489b8837ac3de2f72',
    )
  })
})
