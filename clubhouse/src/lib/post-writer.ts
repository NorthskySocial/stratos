import type { OAuthSession } from '@atproto/oauth-client-browser'
import type { ClubhouseConfig } from './config'
import type { RoomCustody } from './types'

const POST_COLLECTION = 'zone.stratos.feed.post'

export class RoomPostConfigurationError extends Error {
  constructor(message = 'Posting needs service configuration for this room.') {
    super(message)
    this.name = 'RoomPostConfigurationError'
  }
}

export interface StratosPostWriter {
  /** A service-owned writer that resolves the canonical room boundary itself. */
  createPost: (input: {
    roomId: string
    text: string
    reply?: ReplyRef
  }) => Promise<PostRef>
  /** Delete an authenticated actor's own Stratos-custodied room post. */
  deletePost: (input: { uri: string }) => Promise<void>
}

export interface PostRef {
  uri: string
  cid: string
}
export interface ReplyRef {
  root: PostRef
  parent: PostRef
}

export interface RoomPostInput {
  session: OAuthSession
  /** Custody supplied by the authenticated Stratos room-status response. */
  custody: RoomCustody | null
  roomId: string
  text: string
  config: Pick<ClubhouseConfig, 'pdsSpaceUriByRoom'>
  stratosWriter?: StratosPostWriter
  reply?: ReplyRef
}

export interface RoomPostDeleteInput {
  session: OAuthSession
  /** Custody supplied by the authenticated Stratos room-status response. */
  custody: RoomCustody | null
  uri: string
  cid: string
  stratosWriter?: StratosPostWriter
}

function ownPostRkey(uri: string, did: string): string {
  const prefix = `at://${did}/${POST_COLLECTION}/`
  if (!uri.startsWith(prefix)) {
    throw new Error('You can only delete your own posts.')
  }
  const rkey = uri.slice(prefix.length)
  if (!rkey || /[/?#]/.test(rkey)) {
    throw new Error('The post reference is invalid.')
  }
  return rkey
}

/** Create a topic or reply without accepting a caller-controlled boundary. */
export async function createRoomPost(input: RoomPostInput): Promise<PostRef> {
  const text = input.text.trim()
  if (!text) throw new Error('Write something before posting.')
  if (!input.custody) {
    throw new RoomPostConfigurationError(
      'Posting needs an active room enrollment.',
    )
  }

  if (input.custody === 'stratos') {
    if (!input.stratosWriter) throw new RoomPostConfigurationError()
    return input.stratosWriter.createPost({
      roomId: input.roomId,
      text,
      ...(input.reply ? { reply: input.reply } : {}),
    })
  }

  const space = input.config.pdsSpaceUriByRoom[input.roomId]
  if (!space) throw new RoomPostConfigurationError()
  const response = await input.session.fetchHandler(
    '/xrpc/com.atproto.space.createRecord',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        space,
        repo: input.session.sub,
        collection: POST_COLLECTION,
        validate: false,
        record: {
          $type: 'zone.stratos.feed.post',
          text,
          ...(input.reply ? { reply: input.reply } : {}),
          createdAt: new Date().toISOString(),
        },
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`PDS could not create the post (HTTP ${response.status}).`)
  }
  const result = (await response.json()) as Partial<PostRef>
  if (typeof result.uri !== 'string' || typeof result.cid !== 'string') {
    throw new Error('PDS returned an invalid post reference.')
  }
  return { uri: result.uri, cid: result.cid }
}

/** Delete an owned room post through its authoritative custody path. */
export async function deleteRoomPost(
  input: RoomPostDeleteInput,
): Promise<void> {
  const rkey = ownPostRkey(input.uri, input.session.sub)
  if (!input.custody) {
    throw new RoomPostConfigurationError(
      'Deleting needs an active room enrollment.',
    )
  }

  if (input.custody === 'stratos') {
    if (!input.stratosWriter) {
      throw new RoomPostConfigurationError(
        'Deleting needs service configuration for this room.',
      )
    }
    await input.stratosWriter.deletePost({ uri: input.uri })
    return
  }

  const response = await input.session.fetchHandler(
    '/xrpc/com.atproto.repo.deleteRecord',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: input.session.sub,
        collection: POST_COLLECTION,
        rkey,
        swapRecord: input.cid,
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`PDS could not delete the post (HTTP ${response.status}).`)
  }
}
