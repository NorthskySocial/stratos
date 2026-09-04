import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { deletePost } from '../src/lib/post-deletion'
import type { FeedPost } from '../src/lib/feed'

const DID = 'did:plc:misato'

function post(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    uri: `at://${DID}/app.bsky.feed.post/one`,
    cid: 'misato-cid',
    author: DID,
    authorHandle: 'misato.example',
    text: 'The captain reviews the plan.',
    createdAt: '1998-04-03T00:00:00.000Z',
    boundaries: [],
    isPrivate: false,
    reply: null,
    ...overrides,
  }
}

function agent(deleteRecord = vi.fn().mockResolvedValue({})): Agent {
  return {
    com: { atproto: { repo: { deleteRecord } } },
  } as unknown as Agent
}

function session(fetchHandler = vi.fn()): OAuthSession {
  return { sub: DID, fetchHandler } as unknown as OAuthSession
}

describe('deletePost', () => {
  it('deletes a public post through the user PDS', async () => {
    const deleteRecord = vi.fn().mockResolvedValue({})

    await deletePost({
      post: post(),
      session: session(),
      publicAgent: agent(deleteRecord),
      stratosAgent: null,
    })

    expect(deleteRecord).toHaveBeenCalledWith({
      repo: DID,
      collection: 'app.bsky.feed.post',
      rkey: 'one',
    })
  })

  it('deletes a Stratos-hosted private post through Stratos', async () => {
    const publicDelete = vi.fn().mockResolvedValue({})
    const stratosDelete = vi.fn().mockResolvedValue({})

    await deletePost({
      post: post({
        uri: `at://${DID}/zone.stratos.feed.post/two`,
        isPrivate: true,
      }),
      session: session(),
      publicAgent: agent(publicDelete),
      stratosAgent: agent(stratosDelete),
    })

    expect(stratosDelete).toHaveBeenCalledWith({
      repo: DID,
      collection: 'zone.stratos.feed.post',
      rkey: 'two',
    })
    expect(publicDelete).not.toHaveBeenCalled()
  })

  it('deletes a PDS-hosted private post through the space endpoint', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(new Response(null, {status: 200}))
    const publicDelete = vi.fn().mockResolvedValue({})
    const stratosDelete = vi.fn().mockResolvedValue({})

    await deletePost({
      post: post({
        uri: `at://did:web:stratos.example/space/zone.stratos.space.feed/nerve/${DID}/zone.stratos.feed.post/three`,
        isPrivate: true,
      }),
      session: session(fetchHandler),
      publicAgent: agent(publicDelete),
      stratosAgent: agent(stratosDelete),
    })

    const [path, request] = fetchHandler.mock.calls[0] as [
      string,
      {method: string; headers: Record<string, string>; body: string},
    ]
    expect(path).toBe('/xrpc/com.atproto.space.deleteRecord')
    expect(request).toMatchObject({
      method: 'POST',
      headers: {'content-type': 'application/json'},
    })
    expect(JSON.parse(request.body)).toEqual({
      space:
        'at://did:web:stratos.example/space/zone.stratos.space.feed/nerve',
      repo: DID,
      collection: 'zone.stratos.feed.post',
      rkey: 'three',
    })
    expect(publicDelete).not.toHaveBeenCalled()
    expect(stratosDelete).not.toHaveBeenCalled()
  })

  it('rejects a post owned by another user', async () => {
    await expect(
      deletePost({
        post: post({author: 'did:plc:asuka'}),
        session: session(),
        publicAgent: agent(),
        stratosAgent: null,
      }),
    ).rejects.toThrow('You can only delete your own posts.')
  })

  it('rejects a post URI for another user', async () => {
    const deleteRecord = vi.fn().mockResolvedValue({})

    await expect(
      deletePost({
        post: post({
          uri: 'at://did:plc:asuka/app.bsky.feed.post/two',
        }),
        session: session(),
        publicAgent: agent(deleteRecord),
        stratosAgent: null,
      }),
    ).rejects.toThrow('You can only delete your own posts.')
    expect(deleteRecord).not.toHaveBeenCalled()
  })

  it('reports a failed PDS space deletion', async () => {
    await expect(
      deletePost({
        post: post({
          uri: `at://did:web:stratos.example/space/zone.stratos.space.feed/nerve/${DID}/zone.stratos.feed.post/three`,
          isPrivate: true,
        }),
        session: session(
          vi.fn().mockResolvedValue(new Response(null, {status: 403})),
        ),
        publicAgent: agent(),
        stratosAgent: null,
      }),
    ).rejects.toThrow('PDS deletion failed (403)')
  })
})
