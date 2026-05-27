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

export interface ListPostsOpts {
  boundary: string
  limit: number
  cursor?: string
}

export interface ListPostsResult {
  posts: IndexedPost[]
  cursor?: string
}

export interface FeedgenStore {
  // posts
  upsertPost(input: PostUpsert): Promise<void>
  deletePost(uri: string): Promise<void>
  getPost(uri: string): Promise<IndexedPost | null>
  listPostsByBoundary(opts: ListPostsOpts): Promise<ListPostsResult>

  // sync cursor
  upsertCursor(did: string, seq: number, updatedAt: string): Promise<void>
  getCursor(did: string): Promise<number | null>

  // enrolled actor
  upsertEnrolledActor(input: EnrolledActorUpsert): Promise<void>
  getEnrolledActor(did: string): Promise<EnrolledActor | null>
  listEnrolledActors(): Promise<EnrolledActor[]>
  deleteEnrolledActor(did: string): Promise<void>

  close(): Promise<void>
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
