import type { Server as XrpcServer } from '@atproto/xrpc-server'
import type { FeedRegistry, FeedDescription } from '../../feeds/index.js'
import { NSID } from '../../lexicon/index.js'

export interface DescribeFeedDeps {
  feedgenServiceDid: string
  feeds: FeedRegistry
}

export interface FeedDescriptionView {
  id: string
  boundary: string
  displayName?: string
  description?: string
}

export interface DescribeFeedOutput {
  did: string
  feeds: FeedDescriptionView[]
}

export function registerDescribeFeedHandler(
  server: XrpcServer,
  deps: DescribeFeedDeps,
): void {
  server.method(NSID.describeFeed, {
    handler: async () => ({
      encoding: 'application/json',
      body: {
        did: deps.feedgenServiceDid,
        feeds: deps.feeds.list().map(toFeedDescriptionView),
      } satisfies DescribeFeedOutput,
    }),
  })
}

function toFeedDescriptionView(feed: FeedDescription): FeedDescriptionView {
  const out: FeedDescriptionView = { id: feed.id, boundary: feed.boundary }
  if (feed.displayName !== undefined) out.displayName = feed.displayName
  if (feed.description !== undefined) out.description = feed.description
  return out
}
