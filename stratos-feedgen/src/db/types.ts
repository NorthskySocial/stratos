export interface BlobRef {
  cid: string
  mimeType?: string
}

export interface IndexedPost {
  uri: string
  did: string
  cid: string
  sortAt: string
  indexedAt: string
  record: Record<string, unknown>
  blobRefs: BlobRef[]
  boundaries: string[]
}

export interface PostUpsert {
  uri: string
  did: string
  cid: string
  sortAt: string
  indexedAt: string
  record: Record<string, unknown>
  blobRefs: BlobRef[]
  boundaries: string[]
}

export interface EnrolledActor {
  did: string
  boundaries: string[]
  enrolledAt: string
  lastSeenAt: string
}

export interface EnrolledActorUpsert {
  did: string
  boundaries: string[]
  enrolledAt: string
  lastSeenAt: string
}

export interface SpaceMemberSnapshot {
  did: string
  custody: Custody
  host?: string
}

export interface ListPostsOpts {
  boundary: string
  limit: number
  cursor?: string
}

export interface ListPostsResult {
  posts: IndexedPost[]
  cursor?: string
}

export interface GuardedBoundaryDeleteResult {
  committed: boolean
  posts: number
  spaceCursors: number
}

export interface FeedgenStore {
  // posts
  upsertPost: (input: PostUpsert) => Promise<void>
  deletePost: (uri: string) => Promise<void>
  getPost: (uri: string) => Promise<IndexedPost | null>
  listPostsByBoundary: (opts: ListPostsOpts) => Promise<ListPostsResult>

  // deletion / purge helpers
  /** Delete every post (and its cascaded boundary rows) authored by `did`. Returns rows removed. */
  deletePostsByDid: (did: string) => Promise<number>
  /**
   * Remove `did`'s membership in `boundary` from the post/index. Posts that are
   * left with no remaining boundary rows are deleted outright. Returns the
   * number of posts fully deleted.
   */
  deletePostsByDidBoundary: (did: string, boundary: string) => Promise<number>
  /**
   * Atomically delete one actor's space cursor and boundary-scoped post state.
   * The final synchronous guard is evaluated after both deletes; a false
   * result rolls the transaction back and reports `committed: false`.
   */
  deleteActorBoundaryStateGuarded: (
    spaceUri: string,
    did: string,
    boundary: string,
    shouldCommit: () => boolean,
  ) => Promise<GuardedBoundaryDeleteResult>
  /** Delete every post scoped (in any actor) to `boundary`, service-wide. Returns rows removed. */
  deletePostsByBoundary: (boundary: string) => Promise<number>
  /** Delete the sync cursor for `did`. Returns rows removed (0 or 1). */
  deleteCursor: (did: string) => Promise<number>
  /** Delete the stored space cursor for one (space, member) pair. Returns rows removed (0 or 1). */
  deleteSpaceCursor: (spaceUri: string, did: string) => Promise<number>
  /** Delete every space cursor held for `did`, across all spaces. Returns rows removed. */
  deleteSpaceCursors: (did: string) => Promise<number>
  /** Delete every member cursor held for `spaceUri`. Returns rows removed. */
  deleteSpaceCursorsBySpace: (spaceUri: string) => Promise<number>

  // sync cursor
  upsertCursor: (did: string, seq: number, updatedAt: string) => Promise<void>
  getCursor: (did: string) => Promise<number | null>

  // space sync cursor (per space, per member)
  upsertSpaceCursor: (
    spaceUri: string,
    did: string,
    cursor: string,
    updatedAt: string,
  ) => Promise<void>
  getSpaceCursor: (spaceUri: string, did: string) => Promise<string | null>

  // completed space membership snapshots
  listSpaceMembers: (boundary: string) => Promise<SpaceMemberSnapshot[]>
  replaceSpaceMembers: (
    boundary: string,
    members: SpaceMemberSnapshot[],
  ) => Promise<void>

  // enrolled actor
  upsertEnrolledActor: (input: EnrolledActorUpsert) => Promise<void>
  getEnrolledActor: (did: string) => Promise<EnrolledActor | null>
  listEnrolledActors: () => Promise<EnrolledActor[]>
  deleteEnrolledActor: (did: string) => Promise<void>

  close: () => Promise<void>
}

const CURSOR_SEPARATOR = '::'

export function encodeCursor(sortAt: string, uri: string): string {
  return `${sortAt}${CURSOR_SEPARATOR}${uri}`
}

export function decodeCursor(
  cursor: string,
): { sortAt: string; uri: string } | null {
  const idx = cursor.indexOf(CURSOR_SEPARATOR)
  if (idx < 0) return null
  const sortAt = cursor.slice(0, idx)
  const uri = cursor.slice(idx + CURSOR_SEPARATOR.length)
  if (!sortAt || !uri) return null
  return { sortAt, uri }
}
import type { Custody } from '@northskysocial/stratos-core'
