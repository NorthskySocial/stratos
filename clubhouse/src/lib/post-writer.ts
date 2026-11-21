import type { OAuthSession } from '@atproto/oauth-client-browser'
import { parseRecordAddress } from '@northskysocial/stratos-client'
import type { ClubhouseConfig } from './config'
import { ownValue } from './dictionary'
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
  deletePost: (input: { uri: string; cid: string }) => Promise<void>
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

// The address is valid and the member's own, but it names the other custody,
// so neither delete path could reach the post.
function postKeptElsewhere(): Error {
  return new Error(
    'This post cannot be deleted from here. Your posts are kept in a different place from this one.',
  )
}

/** What an own room post's address says about where it lives. */
export type OwnRoomPost =
  | { kind: 'custody' }
  | { kind: 'space'; space: string; rkey: string }

/**
 * Check that a feed post reference names a post of the signed-in account.
 * Nothing is sent before this passes.
 */
export function ownRoomPost(uri: string, did: string): OwnRoomPost {
  const address = parseRecordAddress(uri)
  if (!address.ok) throw new Error('The post reference is invalid.')
  const { value } = address
  if (value.author !== did || value.collection !== POST_COLLECTION) {
    throw new Error('You can only delete your own posts.')
  }
  if (value.kind === 'custody') return { kind: 'custody' }
  return {
    kind: 'space',
    space: `at:space/${value.authority}/${value.spaceType}/${value.skey}`,
    rkey: value.rkey,
  }
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

  const space = ownValue(input.config.pdsSpaceUriByRoom, input.roomId)
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
  const target = ownRoomPost(input.uri, input.session.sub)
  if (!input.custody) {
    throw new RoomPostConfigurationError(
      'Deleting needs an active room enrollment.',
    )
  }

  if (input.custody === 'stratos') {
    if (target.kind !== 'custody') throw postKeptElsewhere()
    if (!input.stratosWriter) {
      throw new RoomPostConfigurationError(
        'Deleting needs service configuration for this room.',
      )
    }
    await input.stratosWriter.deletePost({ uri: input.uri, cid: input.cid })
    return
  }

  if (target.kind !== 'space') throw postKeptElsewhere()
  const response = await input.session.fetchHandler(
    '/xrpc/com.atproto.space.deleteRecord',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        space: target.space,
        repo: input.session.sub,
        collection: POST_COLLECTION,
        rkey: target.rkey,
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`PDS could not delete the post (HTTP ${response.status}).`)
  }
}
