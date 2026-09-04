/** Public room metadata. Boundaries are intentionally absent from this type. */
export interface RoomCatalogEntry {
  id: string
  displayName: string
  description: string
  available: boolean
}

export type RoomAccessState =
  | 'joined'
  | 'unjoined'
  | 'unavailable'
  | 'pending'
  /** The authenticated status service could not resolve room access. */
  | 'status-error'

/** Safe writer selection returned by the authenticated room-status service. */
export type RoomCustody = 'stratos' | 'pds'

export interface ClubhouseIdentity {
  did: string
  handle?: string
}

export type RoomFeedState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'UnknownFeed'
  | 'BoundaryMismatch'
  | 'AuthenticationRequired'
  | 'FeedNotReady'
  | 'NetworkError'

export interface ClubhouseIntegration {
  /** Restore the shared browser OAuth session and discovered enrollment. */
  initialize?: () => Promise<ClubhouseIdentity | null>
  /** Begin normal browser OAuth for a user-supplied login handle. */
  signIn?: (handle: string) => Promise<void>
  /** Revoke the current OAuth session and clear the signed-in identity. */
  signOut?: () => Promise<void>
  /** Resolve the viewer's state without exposing an authorization value. */
  getRoomState?: (roomId: string) => RoomAccessState | Promise<RoomAccessState>
  /** Resolve all known room states in one boundary-free service request. */
  getRoomStates?: (
    roomIds: readonly string[],
  ) => Promise<Readonly<Record<string, RoomAccessState>>>
  /** Start the existing enrollment flow for this room ID. */
  requestJoin?: (
    roomId: string,
  ) => void | RoomAccessState | Promise<void | RoomAccessState>
  /** Read one configured feed through the authenticated Feedgen path. */
  getFeed?: (
    roomId: string,
    limit: number,
    cursor?: string,
  ) => Promise<import('./feedgen').FeedPage>
  /** Create a topic or reply through the custody-aware writer seam. */
  createPost?: (
    roomId: string,
    text: string,
    reply?: import('./post-writer').ReplyRef,
  ) => Promise<import('./post-writer').PostRef>
  /** Delete one owned post through the same custody-aware writer seam. */
  deletePost?: (
    roomId: string,
    post: import('./feedgen').ClubhouseFeedPost,
  ) => Promise<void>
}
