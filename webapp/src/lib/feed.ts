import type { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'

interface FeedViewPost {
  post?: {
    uri: string
    cid: string
    record?: Record<string, unknown>
    indexedAt?: string
    author?: { did: string; handle: string }
  }
  reason?: unknown
}

interface StratosTimelineResponse {
  feed?: FeedViewPost[]
  cursor?: string
}

export interface FeedPost {
  uri: string
  cid: string
  text: string
  createdAt: string
  isPrivate: boolean
  hasReply: boolean
  author: string
  authorHandle: string
  boundaries: string[]
}

function authorFromUri(uri: string): string {
  return uri.replace('at://', '').split('/')[0]
}

function boundariesFromRecord(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((v) => v.value)
    .filter((v): v is string => typeof v === 'string')
}

function mapFeedViewPosts(
  feed: FeedViewPost[],
  isPrivate: boolean,
): FeedPost[] {
  return feed.flatMap((item) => {
    if (!item.post || item.reason) return []

    const val = item.post.record ?? {}
    const did = item.post.author?.did ?? authorFromUri(item.post.uri)
    const handle = item.post.author?.handle ?? ''

    return [
      {
        uri: item.post.uri,
        cid: item.post.cid,
        text: (val.text as string) ?? '',
        createdAt: (val.createdAt as string) ?? item.post.indexedAt ?? '',
        isPrivate,
        hasReply: !!val.reply,
        author: did,
        authorHandle: handle !== did ? handle : '',
        boundaries: boundariesFromRecord(val),
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
        author: did,
        authorHandle: '',
        boundaries: [],
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
        author: authorFromUri(r.uri),
        authorHandle: '',
        boundaries: boundariesFromRecord(val),
      }
    })
  } catch {
    return []
  }
}

export async function fetchAppviewStratosPosts(
  session: OAuthSession,
  appviewUrl: string,
): Promise<FeedPost[]> {
  try {
    const url = new URL('/xrpc/zone.stratos.feed.getTimeline', appviewUrl)
    url.searchParams.set('limit', '50')

    const res = await session.fetchHandler(url.href, { method: 'GET' })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`[stratos] getTimeline failed: ${res.status} ${errText}`)
      return []
    }

    const body = (await res.json()) as StratosTimelineResponse
    console.log(`[stratos] getTimeline: ${body.feed?.length ?? 0} posts`)
    return mapFeedViewPosts(body.feed ?? [], true)
  } catch (err) {
    console.error('[stratos] getTimeline error:', err)
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

export function collectDomains(posts: FeedPost[]): string[] {
  const domains = new Set<string>()
  for (const post of posts) {
    for (const b of post.boundaries) {
      domains.add(b)
    }
  }
  return Array.from(domains).sort()
}

export function filterByDomain(
  posts: FeedPost[],
  domain: string | null,
): FeedPost[] {
  if (!domain) return posts
  return posts.filter((p) => !p.isPrivate || p.boundaries.includes(domain))
}

export function feedStats(posts: FeedPost[]): {
  postCount: number
  userCount: number
} {
  const authors = new Set<string>()
  for (const p of posts) authors.add(p.author)
  return { postCount: posts.length, userCount: authors.size }
}

export function resolveHandles(
  posts: FeedPost[],
  currentDid: string,
  currentHandle: string,
): FeedPost[] {
  return posts.map((p) => {
    if (p.authorHandle) return p
    if (p.author === currentDid && currentHandle) {
      return { ...p, authorHandle: currentHandle }
    }
    return p
  })
}
