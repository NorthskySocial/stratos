import { describe, expect, it, vi } from 'vitest'
import { createRoomPost, RoomPostConfigurationError } from './post-writer'

describe('custody-aware room posting', () => {
  it('uses the configured authority space for PDS custody and omits record boundaries', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await createRoomPost({
      session: { sub: 'did:plc:asuka', fetchHandler } as never,
      custody: 'pds',
      roomId: 'tokyo-3',
      text: '  I am here.  ',
      config: { pdsSpaceUriByRoom: { 'tokyo-3': 'at://did:web:stratos.example/space/zone.stratos.space.feed/tokyo-3' } },
    })
    const body = JSON.parse(fetchHandler.mock.calls[0]?.[1].body as string) as { record: Record<string, unknown>; space: string }
    expect(fetchHandler).toHaveBeenCalledWith('/xrpc/com.atproto.space.createRecord', expect.objectContaining({ method: 'POST' }))
    expect(body.space).toBe('at://did:web:stratos.example/space/zone.stratos.space.feed/tokyo-3')
    expect(body.record).toMatchObject({ $type: 'zone.stratos.feed.post', text: 'I am here.' })
    expect(body.record).not.toHaveProperty('boundary')
  })

  it('delegates Stratos custody to a server-approved writer and never supplies a boundary', async () => {
    const createPost = vi.fn().mockResolvedValue(undefined)
    await createRoomPost({
      session: { sub: 'did:plc:rei' } as never,
      custody: 'stratos',
      roomId: 'nerv-hq', text: 'Report in.', config: { pdsSpaceUriByRoom: {} },
      stratosWriter: { createPost },
    })
    expect(createPost).toHaveBeenCalledWith({ roomId: 'nerv-hq', text: 'Report in.' })
  })

  it('fails closed when the deployment has not supplied a safe writer seam', async () => {
    await expect(createRoomPost({
      session: { sub: 'did:plc:shinji' } as never,
      custody: 'stratos',
      roomId: 'nerv-hq', text: 'Hello.', config: { pdsSpaceUriByRoom: {} },
    })).rejects.toBeInstanceOf(RoomPostConfigurationError)
  })
})
