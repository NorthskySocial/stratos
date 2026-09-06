import { describe, expect, it, vi } from 'vitest'
import {
  createRoomPost,
  deleteRoomPost,
  RoomPostConfigurationError,
} from './post-writer'

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
            'at://did:web:stratos.example/space/zone.stratos.space.feed/tokyo-3',
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
      'at://did:web:stratos.example/space/zone.stratos.space.feed/tokyo-3',
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

  it('deletes an owned PDS-custodied post with record compare-and-swap', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))

    await deleteRoomPost({
      session: { sub: 'did:plc:asuka', fetchHandler } as never,
      custody: 'pds',
      uri: 'at://did:plc:asuka/zone.stratos.feed.post/3k2',
      cid: 'bafy-asuka',
    })

    expect(fetchHandler).toHaveBeenCalledWith(
      '/xrpc/com.atproto.repo.deleteRecord',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: 'did:plc:asuka',
          collection: 'zone.stratos.feed.post',
          rkey: '3k2',
          swapRecord: 'bafy-asuka',
        }),
      },
    )
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
})
