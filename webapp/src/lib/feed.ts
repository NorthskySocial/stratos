import type { Agent } from '@atproto/api'
import { blobUrl, thumbUrl } from './slingshot'

export interface PostImage {
  alt: string
  thumb: string
  fullsize: string
}

export interface FeedPost {
  uri: string
  cid: string
  text: string
  createdAt: string
  isPrivate: boolean
  hasReply: boolean
  images: PostImage[]
  authorDid: string
}

function extractImages(
  val: Record<string, unknown>,
  did: string,
): PostImage[] {
  const embed = val.embed as Record<string, unknown> | undefined
  if (!embed || embed.$type !== 'app.bsky.embed.images') return []
  const images = embed.images as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(images)) return []
  return images
    .map((img) => {
      const blob = img.image as Record<string, unknown> | undefined
      const ref = blob?.ref as Record<string, unknown> | undefined
      const cid = ref?.$link as string | undefined
      if (!cid) return null
      return {
        alt: (img.alt as string) ?? '',
        thumb: thumbUrl(did, cid),
        fullsize: blobUrl(did, cid),
      }
    })
    .filter((x): x is PostImage => x !== null)
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
        images: extractImages(val, did),
        authorDid: did,
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
        images: extractImages(val, did),
        authorDid: did,
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
