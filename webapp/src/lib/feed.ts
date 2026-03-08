import type { Agent } from '@atproto/api'

export interface FeedPost {
  uri: string
  cid: string
  text: string
  createdAt: string
  isPrivate: boolean
  hasReply: boolean
}

export async function fetchPublicPosts(
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

export function buildUnifiedFeed(
  publicPosts: FeedPost[],
  stratosPosts: FeedPost[],
): FeedPost[] {
  return [...publicPosts, ...stratosPosts].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}
