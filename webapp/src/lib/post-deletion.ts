import type { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { postDeleteTargetFromUri, type FeedPost } from './feed'

export interface DeletePostInput {
  post: FeedPost
  session: OAuthSession
  publicAgent: Agent
  stratosAgent: Agent | null
}

/** Deletes a post through the host that holds its record. */
export async function deletePost({
  post,
  session,
  publicAgent,
  stratosAgent,
}: DeletePostInput): Promise<void> {
  if (post.author !== session.sub) {
    throw new Error('You can only delete your own posts.')
  }

  const target = postDeleteTargetFromUri(post.uri)
  if (!target) {
    throw new Error('The post URI is invalid.')
  }
  if (target.repo !== session.sub) {
    throw new Error('You can only delete your own posts.')
  }

  if (target.space) {
    const response = await session.fetchHandler(
      '/xrpc/com.atproto.space.deleteRecord',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target),
      },
    )
    if (!response.ok) {
      throw new Error(`PDS deletion failed (${response.status})`)
    }
    return
  }

  const agent = post.isPrivate ? stratosAgent : publicAgent
  if (!agent) {
    throw new Error('The Stratos service is not connected.')
  }
  await agent.com.atproto.repo.deleteRecord(target)
}
