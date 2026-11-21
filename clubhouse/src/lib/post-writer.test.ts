import { describe, expect, it, vi } from 'vitest'
import {
  createRoomPost,
  deleteRoomPost,
  RoomPostConfigurationError,
} from './post-writer'

const LEGACY_SPACE_RECORD = `at://did:web:stratos.example/space/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/3k5`

describe('custody-aware room posting', () => {
  it('uses the configured authority space for PDS custody and omits record boundaries', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          uri: 'at://did:plc:asuka/zone.stratos.feed.post/1',
          cid: 'bafy-asuka',
        }),
        { status: 200 },
      ),
    )
    await createRoomPost({
      session: { sub: 'did:plc:asuka', fetchHandler } as never,
      custody: 'pds',
      roomId: 'tokyo-3',
      text: '  I am here.  ',
      config: {
        pdsSpaceUriByRoom: {
          'tokyo-3':
            'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3',
        },
      },
      reply: {
        root: {
          uri: 'at://did:plc:rei/zone.stratos.feed.post/root',
          cid: 'bafy-root',
        },
        parent: {
          uri: 'at://did:plc:rei/zone.stratos.feed.post/parent',
          cid: 'bafy-parent',
        },
      },
    })
    const requestInit = fetchHandler.mock.calls[0]?.[1] as
      | RequestInit
      | undefined
    const body = JSON.parse(requestInit?.body as string) as {
      record: Record<string, unknown>
      space: string
    }
    expect(fetchHandler).toHaveBeenCalledWith(
      '/xrpc/com.atproto.space.createRecord',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(body.space).toBe(
      'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3',
    )
    expect(body.record).toMatchObject({
      $type: 'zone.stratos.feed.post',
      text: 'I am here.',
      reply: {
        root: { cid: 'bafy-root' },
        parent: { cid: 'bafy-parent' },
      },
    })
    expect(body.record).not.toHaveProperty('boundary')
  })

  it('delegates Stratos custody to a server-approved writer and never supplies a boundary', async () => {
    const createPost = vi.fn().mockResolvedValue(undefined)
    const deletePost = vi.fn().mockResolvedValue(undefined)
    await createRoomPost({
      session: { sub: 'did:plc:rei' } as never,
      custody: 'stratos',
      roomId: 'nerv-hq',
      text: 'Report in.',
      config: { pdsSpaceUriByRoom: {} },
      stratosWriter: { createPost, deletePost },
    })
    expect(createPost).toHaveBeenCalledWith({
      roomId: 'nerv-hq',
      text: 'Report in.',
    })
  })

  it('fails closed when the deployment has not supplied a safe writer seam', async () => {
    await expect(
      createRoomPost({
        session: { sub: 'did:plc:shinji' } as never,
        custody: 'stratos',
        roomId: 'nerv-hq',
        text: 'Hello.',
        config: { pdsSpaceUriByRoom: {} },
      }),
    ).rejects.toBeInstanceOf(RoomPostConfigurationError)
  })

  it('deletes an owned PDS-custodied post through the space method, with the author as repo', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }))

    await deleteRoomPost({
      session: { sub: 'did:plc:asuka', fetchHandler } as never,
      custody: 'pds',
      uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/3k2',
      cid: 'bafy-asuka',
    })

    expect(fetchHandler).toHaveBeenCalledTimes(1)
    expect(fetchHandler).toHaveBeenCalledWith(
      '/xrpc/com.atproto.space.deleteRecord',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          space:
            'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3',
          repo: 'did:plc:asuka',
          collection: 'zone.stratos.feed.post',
          rkey: '3k2',
        }),
      },
    )
  })

  it('never calls the public repository delete for PDS custody', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }))
    await deleteRoomPost({
      session: { sub: 'did:plc:asuka', fetchHandler } as never,
      custody: 'pds',
      uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/3k2',
      cid: 'bafy-asuka',
    })
    expect(
      fetchHandler.mock.calls.map(([path]) => path as string),
    ).not.toContain('/xrpc/com.atproto.repo.deleteRecord')
  })

  it('shows the failure and keeps the post when the PDS refuses the delete', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 500 }))
    await expect(
      deleteRoomPost({
        session: { sub: 'did:plc:asuka', fetchHandler } as never,
        custody: 'pds',
        uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/3k2',
        cid: 'bafy-asuka',
      }),
    ).rejects.toThrow('PDS could not delete the post (HTTP 500).')
  })

  it('delegates an owned Stratos-custodied post deletion', async () => {
    const deletePost = vi.fn().mockResolvedValue(undefined)

    await deleteRoomPost({
      session: { sub: 'did:plc:rei' } as never,
      custody: 'stratos',
      uri: 'at://did:plc:rei/zone.stratos.feed.post/3k3',
      cid: 'bafy-rei',
      stratosWriter: { createPost: vi.fn(), deletePost },
    })

    expect(deletePost).toHaveBeenCalledWith({
      uri: 'at://did:plc:rei/zone.stratos.feed.post/3k3',
      cid: 'bafy-rei',
    })
  })

  it('rejects deletion of another actor post before making a request', async () => {
    const fetchHandler = vi.fn()

    await expect(
      deleteRoomPost({
        session: { sub: 'did:plc:rei', fetchHandler } as never,
        custody: 'pds',
        uri: 'at://did:plc:asuka/zone.stratos.feed.post/3k4',
        cid: 'bafy-asuka',
      }),
    ).rejects.toThrow('only delete your own posts')
    expect(fetchHandler).not.toHaveBeenCalled()
  })

  it('rejects deletion of another author space post, even when the signed-in account is the space authority', async () => {
    const fetchHandler = vi.fn()

    await expect(
      deleteRoomPost({
        session: { sub: 'did:web:stratos.example', fetchHandler } as never,
        custody: 'pds',
        uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/3k4',
        cid: 'bafy-asuka',
      }),
    ).rejects.toThrow('You can only delete your own posts.')
    expect(fetchHandler).not.toHaveBeenCalled()
  })

  it('rejects deletion of an own record in another collection', async () => {
    const fetchHandler = vi.fn()

    await expect(
      deleteRoomPost({
        session: { sub: 'did:plc:asuka', fetchHandler } as never,
        custody: 'pds',
        uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.like/3k4',
        cid: 'bafy-asuka',
      }),
    ).rejects.toThrow('You can only delete your own posts.')
    expect(fetchHandler).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty string', ''],
    [
      'a public URI with a handle',
      'at://asuka.example/zone.stratos.feed.post/3k5',
    ],
    ['an earlier-spelling record', LEGACY_SPACE_RECORD],
    [
      'a space URI with no record',
      'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3',
    ],
    [
      'a record key with a query',
      'at://did:plc:asuka/zone.stratos.feed.post/3k5?x=1',
    ],
    ['plain text', 'the post about Tokyo-3'],
  ])(
    'rejects %s as an invalid reference without a request',
    async (_label, uri) => {
      const fetchHandler = vi.fn()
      const deletePost = vi.fn()

      for (const custody of ['pds', 'stratos'] as const) {
        await expect(
          deleteRoomPost({
            session: { sub: 'did:plc:asuka', fetchHandler } as never,
            custody,
            uri,
            cid: 'bafy-asuka',
            stratosWriter: { createPost: vi.fn(), deletePost },
          }),
        ).rejects.toThrow('The post reference is invalid.')
      }
      expect(fetchHandler).not.toHaveBeenCalled()
      expect(deletePost).not.toHaveBeenCalled()
    },
  )

  it('refuses a space post in a Stratos-custody room and a custody post in a PDS-custody room', async () => {
    const KEPT_ELSEWHERE =
      'This post cannot be deleted from here. Your posts are kept in a different place from this one.'
    const fetchHandler = vi.fn()
    const deletePost = vi.fn()

    await expect(
      deleteRoomPost({
        session: { sub: 'did:plc:asuka', fetchHandler } as never,
        custody: 'stratos',
        uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/3k5',
        cid: 'bafy-asuka',
        stratosWriter: { createPost: vi.fn(), deletePost },
      }),
    ).rejects.toThrow(KEPT_ELSEWHERE)
    await expect(
      deleteRoomPost({
        session: { sub: 'did:plc:asuka', fetchHandler } as never,
        custody: 'pds',
        uri: 'at://did:plc:asuka/zone.stratos.feed.post/3k5',
        cid: 'bafy-asuka',
        stratosWriter: { createPost: vi.fn(), deletePost },
      }),
    ).rejects.toThrow(KEPT_ELSEWHERE)
    expect(fetchHandler).not.toHaveBeenCalled()
    expect(deletePost).not.toHaveBeenCalled()
  })

  it('sends root and parent as served when replying in a PDS-custody room', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/1',
          cid: 'bafy-asuka',
        }),
        { status: 200 },
      ),
    )
    const root = {
      uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:rei/zone.stratos.feed.post/root',
      cid: 'bafy-root',
    }
    const parent = {
      uri: 'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3/did:plc:shinji/zone.stratos.feed.post/parent',
      cid: 'bafy-parent',
    }
    await createRoomPost({
      session: { sub: 'did:plc:asuka', fetchHandler } as never,
      custody: 'pds',
      roomId: 'tokyo-3',
      text: 'Understood.',
      config: {
        pdsSpaceUriByRoom: {
          'tokyo-3':
            'at:space/did:web:stratos.example/zone.stratos.space.feed/tokyo-3',
        },
      },
      reply: { root, parent },
    })
    const body = JSON.parse(
      (fetchHandler.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { record: { reply: unknown } }
    expect(body.record.reply).toEqual({ root, parent })
  })

  it('refuses to post for PDS custody when the room has no valid space configured', async () => {
    const fetchHandler = vi.fn()
    await expect(
      createRoomPost({
        session: { sub: 'did:plc:asuka', fetchHandler } as never,
        custody: 'pds',
        roomId: 'tokyo-3',
        text: 'Hello.',
        config: { pdsSpaceUriByRoom: {} },
      }),
    ).rejects.toBeInstanceOf(RoomPostConfigurationError)
    expect(fetchHandler).not.toHaveBeenCalled()
  })
})
