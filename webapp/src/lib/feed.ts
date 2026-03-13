import type { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

interface FeedViewPost {
  post?: {
    uri: string
    cid: string
    record?: Record<string, unknown>
    indexedAt?: string
  }
  reason?: unknown
}

interface StratosAuthorFeedResponse {
  feed?: FeedViewPost[]
}

export interface FeedPost {
  uri: string
  cid: string
  text: string
  createdAt: string
  isPrivate: boolean
  hasReply: boolean
}

function mapFeedViewPosts(
  feed: FeedViewPost[],
  isPrivate: boolean,
): FeedPost[] {
  return feed.flatMap((item) => {
    if (!item.post || item.reason) {
      return []
    }

    const val = item.post.record ?? {}
    return [
      {
        uri: item.post.uri,
        cid: item.post.cid,
        text: (val.text as string) ?? '',
        createdAt: (val.createdAt as string) ?? item.post.indexedAt ?? '',
        isPrivate,
        hasReply: !!val.reply,
      },
    ]
  })
}

export async function fetchRepoPublicPosts(
  agent: Agent,
  did: string,
): Promise<FeedPost[]> {
  try {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: 'app.bsky.feed.post',
      limit: 50,
    })
    return res.data.records.map((r) => {
      const val = r.value as Record<string, unknown>
      return {
        uri: r.uri,
        cid: r.cid,
        text: (val.text as string) ?? '',
        createdAt: (val.createdAt as string) ?? '',
        isPrivate: false,
        hasReply: !!val.reply,
      }
    })
  } catch {
    return []
  }
}

export async function fetchPublicPosts(
  agent: Agent,
  did: string,
): Promise<FeedPost[]> {
  try {
    const res = await agent.app.bsky.feed.getAuthorFeed({
      actor: did,
      filter: 'posts_with_replies',
      limit: 50,
    })
    return mapFeedViewPosts(res.data.feed as FeedViewPost[], false)
  } catch {
    return []
  }
}

export async function fetchStratosPosts(
  stratosAgent: Agent,
  did: string,
): Promise<FeedPost[]> {
  try {
    const res = await stratosAgent.com.atproto.repo.listRecords({
      repo: did,
      collection: 'zone.stratos.feed.post',
      limit: 50,
    })
    return res.data.records.map((r) => {
      const val = r.value as Record<string, unknown>
      return {
        uri: r.uri,
        cid: r.cid,
        text: (val.text as string) ?? '',
        createdAt: (val.createdAt as string) ?? '',
        isPrivate: true,
        hasReply: !!val.reply,
      }
    })
  } catch {
    return []
  }
}

export async function fetchAppviewStratosPosts(
  session: OAuthSession,
  appviewUrl: string,
  did: string,
): Promise<FeedPost[]> {
  try {
    const url = new URL('/xrpc/zone.stratos.feed.getAuthorFeed', appviewUrl)
    url.searchParams.set('actor', did)
    url.searchParams.set('limit', '50')

    const res = await session.fetchHandler(url.href, { method: 'GET' })
    if (!res.ok) {
      return []
    }

    const body = (await res.json()) as StratosAuthorFeedResponse
    return mapFeedViewPosts(body.feed ?? [], true)
  } catch {
    return []
  }
}

export function buildUnifiedFeed(
  publicPosts: FeedPost[],
  stratosPosts: FeedPost[],
): FeedPost[] {
  return [...publicPosts, ...stratosPosts].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}
