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

export interface StrongRef {
  uri: string
  cid: string
}

export interface ReplyRef {
  root: StrongRef
  parent: StrongRef
}

export interface FeedPost {
  uri: string
  cid: string
  text: string
  createdAt: string
  isPrivate: boolean
  reply: ReplyRef | null
  author: string
  authorHandle: string
  boundaries: string[]
}

export interface ThreadNode {
  post: FeedPost
  replies: ThreadNode[]
  depth: number
}

function authorFromUri(uri: string): string {
  return uri.replace('at://', '').split('/')[0]
}

function parseReplyRef(record: Record<string, unknown>): ReplyRef | null {
  const reply = record.reply as
    | {
        root?: { uri?: string; cid?: string }
        parent?: { uri?: string; cid?: string }
      }
    | undefined
  if (
    !reply?.root?.uri ||
    !reply?.root?.cid ||
    !reply?.parent?.uri ||
    !reply?.parent?.cid
  ) {
    return null
  }
  return {
    root: { uri: reply.root.uri, cid: reply.root.cid },
    parent: { uri: reply.parent.uri, cid: reply.parent.cid },
  }
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
        reply: parseReplyRef(val),
        author: did,
        authorHandle: handle !== did ? handle : '',
        boundaries: boundariesFromRecord(val),
      },
    ]
  })
}

/**
 * Fetch public posts from the repo
 * @param agent - Agent instance for interacting with the repo
 * @param did - DID of the repository to fetch posts from
 * @returns Array of FeedPost objects fetched from the repository
 */
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
        reply: parseReplyRef(val),
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

/**
 * Fetch Stratos posts for a given DID
 * @param stratosAgent - Stratos agent instance
 * @param did - DID of the user to fetch posts for
 * @returns Array of FeedPost objects
 */
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
        reply: parseReplyRef(val),
        author: authorFromUri(r.uri),
        authorHandle: '',
        boundaries: boundariesFromRecord(val),
      }
    })
  } catch {
    return []
  }
}

/**
 * Fetch Stratos posts from an appview instance
 * @param session - OAuth session for the user
 * @param appviewUrl - URL of the appview instance
 * @returns Array of FeedPost objects
 */
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

/**
 * Combine public and Stratos posts into a unified feed
 * @param publicPosts - Public posts from other sources
 * @param stratosPosts - Stratos posts from the user's Stratos instance
 * @returns Array of FeedPost objects sorted by creation time
 */
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

/**
 * Filters posts by domain. If domain is null, returns all posts.
 * @param posts - Posts to filter
 * @param domain - Domain to filter by, or null to return all posts
 * @returns Array of filtered posts
 */
export function filterByDomain(
  posts: FeedPost[],
  domain: string | null,
): FeedPost[] {
  if (!domain) return posts
  return posts.filter((p) => !p.isPrivate || p.boundaries.includes(domain))
}

/**
 * Calculates statistics for a feed of posts.
 * @param posts - Posts to calculate stats for
 * @returns Object with postCount and userCount properties
 */
export function feedStats(posts: FeedPost[]): {
  postCount: number
  userCount: number
} {
  const authors = new Set<string>()
  for (const p of posts) authors.add(p.author)
  return { postCount: posts.length, userCount: authors.size }
}

/**
 * Resolves author handles for posts, using current DID and handle if available.
 * @param posts - Posts to resolve handles for
 * @param currentDid - Current user's DID
 * @param currentHandle - Current user's handle
 * @returns Array of posts with resolved handles
 */
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

/**
 * Groups posts into threads based on reply structure.
 * @param posts - Posts to group
 * @returns Array of ThreadNode objects
 */
export function groupIntoThreads(posts: FeedPost[]): ThreadNode[] {
  const byUri = new Map<string, FeedPost>()
  for (const p of posts) byUri.set(p.uri, p)

  const childrenOf = new Map<string, FeedPost[]>()
  const rootPosts: FeedPost[] = []

  for (const p of posts) {
    if (p.reply && byUri.has(p.reply.parent.uri)) {
      const parentUri = p.reply.parent.uri
      const siblings = childrenOf.get(parentUri) ?? []
      siblings.push(p)
      childrenOf.set(parentUri, siblings)
    } else {
      rootPosts.push(p)
    }
  }

  function buildTree(post: FeedPost, depth: number): ThreadNode {
    const replies = (childrenOf.get(post.uri) ?? [])
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      .map((r) => buildTree(r, depth + 1))
    return { post, replies, depth }
  }

  return rootPosts.map((p) => buildTree(p, 0))
}

/**
 * Finds a post by its URI.
 * @param posts - Posts to search
 * @param uri - URI to find
 * @returns The post with the specified URI, or undefined if not found
 */
export function findPost(posts: FeedPost[], uri: string): FeedPost | undefined {
  return posts.find((p) => p.uri === uri)
}
