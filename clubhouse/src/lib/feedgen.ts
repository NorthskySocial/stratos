import type { OAuthSession } from '@atproto/oauth-client-browser'
import { feedgenServiceId } from './config'

export type FeedFailureCode =
  | 'UnknownFeed'
  | 'BoundaryMismatch'
  | 'AuthenticationRequired'
  | 'FeedNotReady'
  | 'NetworkError'
  | 'InvalidResponse'

export class FeedgenError extends Error {
  constructor(
    readonly code: FeedFailureCode,
    message: string,
    readonly httpStatus?: number,
    readonly responseError?: string,
    readonly responseMessage?: string,
  ) {
    super(message)
    this.name = 'FeedgenError'
  }
}

export interface ClubhouseFeedPost {
  uri: string
  cid: string
  author: { did: string; handle?: string }
  text: string
  indexedAt: string
  reply?: { root: StrongRef; parent: StrongRef }
}

export interface StrongRef {
  uri: string
  cid: string
}

export interface FeedPage {
  posts: ClubhouseFeedPost[]
  cursor?: string
}

export interface FeedgenClientConfig {
  feedgenDid?: string
  /** Kept in configuration for deployment visibility; requests route via the PDS proxy. */
  feedgenUrl?: string
}

function messageFor(code: FeedFailureCode): string {
  const messages: Record<FeedFailureCode, string> = {
    UnknownFeed: 'This room is no longer in the current catalogue.',
    BoundaryMismatch: 'Join this room before reading its posts.',
    AuthenticationRequired: 'Sign in to read this room.',
    FeedNotReady: 'Your room is still synchronizing. Try again shortly.',
    NetworkError: 'The feed could not be reached. Try again.',
    InvalidResponse: 'The feed returned an unreadable response.',
  }
  return messages[code]
}

function failureFromResponse(status: number, body: unknown): FeedgenError {
  const response =
    typeof body === 'object' && body !== null
      ? (body as { error?: unknown; message?: unknown })
      : {}
  const error = typeof response.error === 'string' ? response.error : undefined
  const message =
    typeof response.message === 'string' ? response.message : undefined
  if (
    error === 'UnknownFeed' ||
    error === 'BoundaryMismatch' ||
    error === 'FeedNotReady'
  ) {
    return new FeedgenError(error, messageFor(error), status, error, message)
  }
  if (status === 401 || status === 403) {
    return new FeedgenError(
      'AuthenticationRequired',
      messageFor('AuthenticationRequired'),
      status,
      error,
      message,
    )
  }
  return new FeedgenError(
    'NetworkError',
    `The feed returned HTTP ${status}.`,
    status,
    error,
    message,
  )
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field]
  return typeof value === 'string' ? value : null
}

function strongRef(value: unknown): StrongRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const uri = stringField(record, 'uri')
  const cid = stringField(record, 'cid')
  return uri && cid ? { uri, cid } : undefined
}

/** Extract plain text only; Svelte renders this as text, never supplied HTML. */
export function safePostText(record: unknown): string {
  if (typeof record !== 'object' || record === null) return ''
  const text = (record as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

function parseFeedPage(payload: unknown): FeedPage {
  if (typeof payload !== 'object' || payload === null) {
    throw new FeedgenError('InvalidResponse', messageFor('InvalidResponse'))
  }
  const response = payload as { cursor?: unknown; feed?: unknown }
  if (!Array.isArray(response.feed)) {
    throw new FeedgenError('InvalidResponse', messageFor('InvalidResponse'))
  }
  const posts = response.feed.flatMap((entry): ClubhouseFeedPost[] => {
    const post =
      typeof entry === 'object' && entry !== null
        ? (entry as { post?: unknown }).post
        : undefined
    if (typeof post !== 'object' || post === null) return []
    const value = post as Record<string, unknown>
    const uri = stringField(value, 'uri')
    const cid = stringField(value, 'cid')
    const indexedAt = stringField(value, 'indexedAt')
    const authorValue = value.author
    if (
      !uri ||
      !cid ||
      !indexedAt ||
      typeof authorValue !== 'object' ||
      authorValue === null
    )
      return []
    const author = authorValue as Record<string, unknown>
    const did = stringField(author, 'did')
    if (!did) return []
    const handle = stringField(author, 'handle') ?? undefined
    const record =
      typeof value.record === 'object' && value.record !== null
        ? (value.record as Record<string, unknown>)
        : {}
    const replyValue =
      typeof record.reply === 'object' && record.reply !== null
        ? (record.reply as Record<string, unknown>)
        : undefined
    const root = strongRef(replyValue?.root)
    const parent = strongRef(replyValue?.parent)
    return [
      {
        uri,
        cid,
        indexedAt,
        author: { did, handle },
        text: safePostText(value.record),
        ...(root && parent ? { reply: { root, parent } } : {}),
      },
    ]
  })
  return {
    posts,
    cursor: typeof response.cursor === 'string' ? response.cursor : undefined,
  }
}

/** Call the one supported Feedgen query through the authenticated PDS proxy. */
export async function getFeed(
  session: OAuthSession,
  config: FeedgenClientConfig,
  input: { feed: string; limit: number; cursor?: string },
): Promise<FeedPage> {
  if (!config.feedgenDid) {
    throw new FeedgenError(
      'NetworkError',
      'Feedgen is not configured for this deployment.',
    )
  }
  const parameters = new URLSearchParams({
    feed: input.feed,
    limit: String(Math.min(100, Math.max(1, input.limit))),
  })
  if (input.cursor) parameters.set('cursor', input.cursor)
  let response: Response
  try {
    response = await session.fetchHandler(
      `/xrpc/zone.stratos.feedgen.getFeed?${parameters.toString()}`,
      {
        method: 'GET',
        headers: { 'atproto-proxy': feedgenServiceId(config.feedgenDid) },
      },
    )
  } catch (error) {
    throw new FeedgenError(
      'NetworkError',
      error instanceof Error ? error.message : messageFor('NetworkError'),
    )
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw failureFromResponse(response.status, body)
  return parseFeedPage(body)
}

/** Cursor values are never shared between feeds. */
export class FeedCursorStore {
  #cursors = new Map<string, string>()

  get(feedId: string): string | undefined {
    return this.#cursors.get(feedId)
  }

  set(feedId: string, cursor: string | undefined): void {
    if (cursor) this.#cursors.set(feedId, cursor)
    else this.#cursors.delete(feedId)
  }

  reset(feedId: string): void {
    this.#cursors.delete(feedId)
  }
}
