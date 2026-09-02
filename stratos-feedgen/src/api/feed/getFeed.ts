import {
  NotEnoughResourcesError,
  type Server as XrpcServer,
} from '@atproto/xrpc-server'
import type { FeedgenStore, IndexedPost } from '../../db/index.js'
import { decodeCursor, encodeCursor } from '../../db/index.js'
import type { EnrollmentManager } from '../../enrollment/index.js'
import type { FeedRegistry } from '../../feeds/index.js'
import { NSID } from '../../lexicon/index.js'
import type { FeedReadiness } from '../../readiness.js'
import {
  BoundaryMismatchError,
  UnknownFeedError,
  toXrpcAuthVerifier,
  type XrpcAuthCredentials,
} from '../util.js'
import type { FeedRequestVerifier } from '../../auth/index.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export interface GetFeedDeps {
  feeds: FeedRegistry
  store: Pick<FeedgenStore, 'listPostsByBoundary'>
  enrollmentManager: Pick<EnrollmentManager, 'getBoundaries'>
  verifier: FeedRequestVerifier
  /** Omitted means the caller has no replay-readiness requirement. */
  readiness?: FeedReadiness
}

export interface PostView {
  uri: string
  cid: string
  author: { did: string; handle?: string }
  record: Record<string, unknown>
  indexedAt: string
  boundaries: string[]
}

export interface FeedViewPost {
  post: PostView
}

export interface GetFeedOutput {
  cursor?: string
  feed: FeedViewPost[]
}

export function registerGetFeedHandler(
  server: XrpcServer,
  deps: GetFeedDeps,
): void {
  server.method(NSID.getFeed, {
    auth: toXrpcAuthVerifier(deps.verifier),
    handler: async ({ params, auth }) => {
      assertReadiness(deps.readiness)

      const { viewerDid } = auth.credentials
      const feedId = params['feed'] as string
      const limit = clampLimit(params['limit'])
      const cursor = params['cursor'] as string | undefined

      const feed = deps.feeds.get(feedId)
      if (!feed) throw new UnknownFeedError(feedId)

      const viewerBoundaries =
        await deps.enrollmentManager.getBoundaries(viewerDid)
      assertReadiness(deps.readiness)
      if (!viewerBoundaries.includes(feed.boundary)) {
        throw new BoundaryMismatchError(feed.boundary)
      }

      const result = await deps.store.listPostsByBoundary({
        boundary: feed.boundary,
        limit,
        cursor: normalizeCursor(cursor),
      })
      assertReadiness(deps.readiness)

      return {
        encoding: 'application/json',
        body: {
          cursor: result.cursor,
          feed: result.posts.map(toFeedViewPost),
        } satisfies GetFeedOutput,
      }
    },
  })
}

function assertReadiness(readiness: FeedReadiness | undefined): void {
  if (readiness === undefined || readiness.isReady()) return
  throw new NotEnoughResourcesError(
    'Feed is unavailable while authorization state is reconciling',
    'FeedNotReady',
  )
}

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT
  const n = Math.floor(raw)
  if (n < 1) return 1
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
}

function normalizeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  if (decodeCursor(cursor) === null) return undefined
  return cursor
}

function toFeedViewPost(post: IndexedPost): FeedViewPost {
  return {
    post: {
      uri: post.uri,
      cid: post.cid,
      author: { did: post.did },
      record: post.record,
      indexedAt: post.indexedAt,
      boundaries: post.boundaries,
    },
  }
}

export { encodeCursor }
