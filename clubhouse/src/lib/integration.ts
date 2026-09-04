import type { OAuthSession } from '@atproto/oauth-client-browser'
import { createClubhouseAuth } from './auth'
import {
  roomPostEndpoint,
  roomStatusEndpoint,
  type ClubhouseConfig,
} from './config'
import { resolveAuthenticatedHandle } from './enrollment'
import { getFeed, type FeedPage } from './feedgen'
import { rememberRoomReturn, roomJoinUrl } from './join'
import { getActorProfiles, type TypeaheadActor } from './typeahead'
import { captureClubhouseException } from '../telemetry'
import {
  createRoomPost,
  deleteRoomPost,
  RoomPostConfigurationError,
  type ReplyRef,
  type StratosPostWriter,
} from './post-writer'
import type { ClubhouseIdentity, RoomAccessState, RoomCustody } from './types'

interface AccessResponse {
  rooms?: unknown
  custody?: unknown
}

interface RoomStatus {
  states: Readonly<Record<string, RoomAccessState>>
  custody: RoomCustody | null
}

function isAccessState(value: unknown): value is RoomAccessState {
  return (
    value === 'joined' ||
    value === 'unjoined' ||
    value === 'pending' ||
    value === 'unavailable' ||
    value === 'status-error'
  )
}

function parseRoomStates(
  payload: AccessResponse,
  knownRoomIds: readonly string[],
): Readonly<Record<string, RoomAccessState>> {
  if (!Array.isArray(payload.rooms)) return {}
  const known = new Set(knownRoomIds)
  const states: Record<string, RoomAccessState> = {}
  for (const item of payload.rooms) {
    if (typeof item !== 'object' || item === null) continue
    const { id, state } = item as { id?: unknown; state?: unknown }
    if (typeof id === 'string' && known.has(id) && isAccessState(state)) {
      states[id] = state
    }
  }
  return states
}

function parseCustody(value: unknown): RoomCustody | null {
  return value === 'pds' || value === 'stratos' ? value : null
}

async function requestRoomStatus(
  session: OAuthSession,
  endpoint: string,
  roomIds: readonly string[],
): Promise<RoomStatus> {
  const response = await session.fetchHandler(endpoint, { method: 'GET' })
  if (!response.ok)
    throw new Error(`Room status returned HTTP ${response.status}.`)
  const payload = (await response.json()) as AccessResponse
  return {
    states: parseRoomStates(payload, roomIds),
    custody: parseCustody(payload.custody),
  }
}

function createServiceRoomPostWriter(
  session: OAuthSession,
  config: ClubhouseConfig,
): StratosPostWriter | undefined {
  const endpoint = roomPostEndpoint(config)
  if (!endpoint) return undefined
  return {
    async createPost({ roomId, text, reply }) {
      const response = await session.fetchHandler(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId, text, ...(reply ? { reply } : {}) }),
      })
      if (response.ok)
        return (await response.json()) as { uri: string; cid: string }

      const payload: unknown = await response.json().catch(() => undefined)
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `Stratos could not create the post (HTTP ${response.status}).`
      throw new Error(message)
    },
    async deletePost({ uri }) {
      const response = await session.fetchHandler(endpoint, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri }),
      })
      if (response.ok) return

      const payload: unknown = await response.json().catch(() => undefined)
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : `Stratos could not delete the post (HTTP ${response.status}).`
      throw new Error(message)
    },
  }
}

/**
 * App integration contains session and transport seams. It has no boundary map:
 * room access is a response from an optional service endpoint, never browser policy.
 */
export function createClubhouseIntegration(
  config: ClubhouseConfig,
  dependencies: {
    navigate?: (url: string) => void
    stratosWriter?: StratosPostWriter
    typeaheadFetcher?: typeof fetch
  } = {},
) {
  const auth = createClubhouseAuth(config)
  let session: OAuthSession | null = null
  let identity: ClubhouseIdentity | null = null
  const authorProfiles = new Map<string, TypeaheadActor | null>()

  async function enrichAuthors(page: FeedPage): Promise<FeedPage> {
    const missing = [
      ...new Set(
        page.posts
          .filter((post) => !post.author.avatar)
          .map((post) => post.author.did)
          .filter((did) => !authorProfiles.has(did)),
      ),
    ]
    if (missing.length > 0) {
      try {
        const resolved = await getActorProfiles(
          missing,
          dependencies.typeaheadFetcher ?? globalThis.fetch,
        )
        for (const did of missing) {
          authorProfiles.set(did, resolved.get(did) ?? null)
        }
      } catch (error) {
        captureClubhouseException(error)
      }
    }

    return {
      ...page,
      posts: page.posts.map((post) => {
        const profile = authorProfiles.get(post.author.did)
        return profile
          ? { ...post, author: { ...post.author, ...profile } }
          : post
      }),
    }
  }

  async function refresh(): Promise<ClubhouseIdentity | null> {
    session = await auth.init()
    if (!session) {
      identity = null
      return null
    }
    try {
      identity = {
        did: session.sub,
        handle: await resolveAuthenticatedHandle(session),
      }
    } catch {
      identity = { did: session.sub }
    }
    return identity
  }

  async function getRoomState(roomId: string): Promise<RoomAccessState> {
    const states = await getRoomStates([roomId])
    return states[roomId] ?? (session ? 'status-error' : 'unjoined')
  }

  async function getRoomStates(
    roomIds: readonly string[],
  ): Promise<Readonly<Record<string, RoomAccessState>>> {
    if (!session || roomIds.length === 0) return {}
    const endpoint = roomStatusEndpoint(config)
    if (!endpoint) {
      return Object.fromEntries(
        roomIds.map((roomId) => [roomId, 'status-error']),
      )
    }
    try {
      return (await requestRoomStatus(session, endpoint, roomIds)).states
    } catch (error) {
      captureClubhouseException(error)
      return Object.fromEntries(
        roomIds.map((roomId) => [roomId, 'status-error']),
      )
    }
  }

  return {
    initialize: refresh,
    signIn: auth.signIn,
    async signOut(): Promise<void> {
      await auth.signOut()
      session = null
      identity = null
    },
    getRoomState,
    getRoomStates,
    async requestJoin(roomId: string): Promise<RoomAccessState> {
      if (!session) throw new Error('Sign in before joining a room.')
      // Reuse the identity resolved during session restoration. A DID is also
      // a valid ATProto login hint, so enrollment must not depend on a second
      // PDS handle lookup succeeding.
      const handle = identity?.handle ?? session.sub
      const destination = `/rooms/${encodeURIComponent(roomId)}`
      const url = roomJoinUrl(config, roomId, handle, destination)
      rememberRoomReturn(destination)
      ;(dependencies.navigate ?? ((next) => window.location.assign(next)))(
        url.href,
      )
      return 'pending'
    },
    async getFeed(
      roomId: string,
      limit: number,
      cursor?: string,
    ): Promise<FeedPage> {
      if (!session) throw new Error('Sign in to read this room.')
      const page = await getFeed(session, config, {
        feed: roomId,
        limit,
        cursor,
      })
      return enrichAuthors(page)
    },
    async createPost(roomId: string, text: string, reply?: ReplyRef) {
      if (!session) throw new Error('Sign in before posting.')
      const endpoint = roomStatusEndpoint(config)
      if (!endpoint) throw new RoomPostConfigurationError()
      const { custody } = await requestRoomStatus(session, endpoint, [roomId])
      return createRoomPost({
        session,
        custody,
        roomId,
        text,
        config,
        reply,
        stratosWriter:
          dependencies.stratosWriter ??
          createServiceRoomPostWriter(session, config),
      })
    },
    async deletePost(
      roomId: string,
      post: import('./feedgen').ClubhouseFeedPost,
    ) {
      if (!session) throw new Error('Sign in before deleting a post.')
      const endpoint = roomStatusEndpoint(config)
      if (!endpoint) {
        throw new RoomPostConfigurationError(
          'Deleting needs service configuration for this room.',
        )
      }
      const { custody } = await requestRoomStatus(session, endpoint, [roomId])
      await deleteRoomPost({
        session,
        custody,
        uri: post.uri,
        cid: post.cid,
        stratosWriter:
          dependencies.stratosWriter ??
          createServiceRoomPostWriter(session, config),
      })
    },
    get identity(): ClubhouseIdentity | null {
      return identity
    },
  }
}
