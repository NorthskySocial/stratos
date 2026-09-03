import type { OAuthSession } from '@atproto/oauth-client-browser'
import type { ClubhouseConfig } from './config'
import type { RoomCustody } from './types'

export class RoomPostConfigurationError extends Error {
  constructor(message = 'Posting needs service configuration for this room.') {
    super(message)
    this.name = 'RoomPostConfigurationError'
  }
}

export interface StratosPostWriter {
  /** A service-owned writer that resolves the canonical room boundary itself. */
  createPost(input: { roomId: string; text: string }): Promise<void>
}

export interface RoomPostInput {
  session: OAuthSession
  /** Custody supplied by the authenticated Stratos room-status response. */
  custody: RoomCustody | null
  roomId: string
  text: string
  config: Pick<ClubhouseConfig, 'pdsSpaceUriByRoom'>
  stratosWriter?: StratosPostWriter
}

/** Create a flat, text-only post without accepting a caller-controlled boundary. */
export async function createRoomPost(input: RoomPostInput): Promise<void> {
  const text = input.text.trim()
  if (!text) throw new Error('Write something before posting.')
  if (!input.custody) {
    throw new RoomPostConfigurationError('Posting needs an active room enrollment.')
  }

  if (input.custody === 'stratos') {
    if (!input.stratosWriter) throw new RoomPostConfigurationError()
    await input.stratosWriter.createPost({ roomId: input.roomId, text })
    return
  }

  const space = input.config.pdsSpaceUriByRoom[input.roomId]
  if (!space) throw new RoomPostConfigurationError()
  const response = await input.session.fetchHandler('/xrpc/com.atproto.space.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      space,
      repo: input.session.sub,
      collection: 'zone.stratos.feed.post',
      validate: false,
      record: {
        $type: 'zone.stratos.feed.post',
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  })
  if (!response.ok) {
    throw new Error(`PDS could not create the post (HTTP ${response.status}).`)
  }
}
