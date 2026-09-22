import { createHash } from 'node:crypto'

export interface FeedgenOracleFixture {
  actors: readonly string[]
  boundaries: readonly string[]
  posts: readonly OraclePost[]
  custodyByActor: Readonly<Record<string, ActorCustody>>
}

export type ActorCustody = 'stratos' | 'pds'

export interface OraclePost {
  uri: string
  cid: string
  authorDid: string
  boundary: string
  sortAt: string
}

export const SMALL_ACTOR_COUNT = 104
export const SMALL_BOUNDARY_COUNT = 5
export const SMALL_POST_COUNT = 10_000
export const SCALE_ACTOR_COUNT = 1_000
export const SCALE_POST_COUNT = 100_000

/** Deterministic, synthetic-only fixture truth for differential feed checks. */
export function createSmallOracleFixture(): FeedgenOracleFixture {
  return createOracleFixture(
    SMALL_ACTOR_COUNT,
    SMALL_BOUNDARY_COUNT,
    SMALL_POST_COUNT,
  )
}

/** Capacity fixture; its output is not a small-profile performance claim. */
export function createScaleOracleFixture(): FeedgenOracleFixture {
  return createOracleFixture(
    SCALE_ACTOR_COUNT,
    SMALL_BOUNDARY_COUNT,
    SCALE_POST_COUNT,
  )
}

function createOracleFixture(
  actorCount: number,
  boundaryCount: number,
  postCount: number,
): FeedgenOracleFixture {
  const boundaries = Array.from({ length: boundaryCount }, (_, index) => {
    return `boundary-${index + 1}`
  })
  const actors = Array.from(
    { length: actorCount },
    (_, index) =>
      `did:example:fixture-actor-${String(index + 1).padStart(3, '0')}`,
  )
  const custodyByActor: Record<string, ActorCustody> = {}
  for (const [index, actor] of actors.entries()) {
    custodyByActor[actor] = index % 2 === 0 ? 'stratos' : 'pds'
  }
  const posts = Array.from({ length: postCount }, (_, index) => {
    const actor = actors[index % actors.length]
    const boundary = boundaries[index % boundaries.length]
    const rkey = String(index + 1).padStart(5, '0')
    return {
      uri: `at://${actor}/zone.stratos.feed.post/${rkey}`,
      cid: `bafyfixture${rkey}`,
      authorDid: actor,
      boundary,
      sortAt: new Date(Date.UTC(1998, 3, 3, 0, 0, index % 60)).toISOString(),
    }
  })
  return { actors, boundaries, posts, custodyByActor }
}

/** A stable fingerprint, never derived from or containing private data. */
export function fingerprintFixture(fixture: FeedgenOracleFixture): string {
  return createHash('sha256').update(JSON.stringify(fixture)).digest('hex')
}

export function countPostsByBoundary(
  fixture: FeedgenOracleFixture,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const boundary of fixture.boundaries) counts[boundary] = 0
  for (const post of fixture.posts) counts[post.boundary] += 1
  return counts
}

/** Independent expected visibility for a boundary-scoped feed response. */
export function expectedPostsForBoundary(
  fixture: FeedgenOracleFixture,
  boundary: string,
): readonly OraclePost[] {
  return fixture.posts.filter((post) => post.boundary === boundary)
}
