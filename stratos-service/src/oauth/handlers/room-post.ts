import express from 'express'
import { XRPCError } from '@atproto/xrpc-server'
import { StratosError } from '@northskysocial/stratos-core'
import type { OAuthRoutesConfig } from '../routes.js'

interface RoomPostRequest {
  roomId: string
  text: string
  reply?: ReplyRef
}

interface StrongRef {
  uri: string
  cid: string
}
interface ReplyRef {
  root: StrongRef
  parent: StrongRef
}

function parseStrongRef(value: unknown): StrongRef | null {
  if (typeof value !== 'object' || value === null) return null
  const ref = value as Record<string, unknown>
  return typeof ref.uri === 'string' &&
    ref.uri.startsWith('at://') &&
    ref.uri.includes('/zone.stratos.feed.post/') &&
    typeof ref.cid === 'string' &&
    ref.cid.length > 0
    ? { uri: ref.uri, cid: ref.cid }
    : null
}

function parseReply(value: unknown): ReplyRef | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return null
  const reply = value as Record<string, unknown>
  const root = parseStrongRef(reply.root)
  const parent = parseStrongRef(reply.parent)
  return root && parent ? { root, parent } : null
}

function parseRoomPostRequest(body: unknown): RoomPostRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const value = body as Record<string, unknown>
  if (typeof value.roomId !== 'string' || typeof value.text !== 'string') {
    return null
  }
  const roomId = value.roomId.trim()
  const text = value.text.trim()
  const reply = parseReply(value.reply)
  if (!roomId || !text || reply === null) return null
  return { roomId, text, ...(reply ? { reply } : {}) }
}

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  InvalidRecord: 'The room post is invalid',
  NotEnrolled: 'You must be enrolled to post in this room',
  ServiceWriteForbidden: 'Room posting is not available for this account',
  PdsCustodyWriteForbidden: 'Room posting is not available for this account',
  RateLimitExceeded: 'Too many room posts; try again later',
}

function safeErrorCategory(category: unknown, fallback: string): string {
  return typeof category === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(category)
    ? category
    : fallback
}

function safeRoomPostMessage(category: string, status: number): string {
  return (
    SAFE_ERROR_MESSAGES[category] ??
    (status >= 500
      ? 'The room post service is temporarily unavailable'
      : 'The room post request was rejected')
  )
}

function sendRoomPostWriteError(res: express.Response, err: unknown): boolean {
  if (err instanceof XRPCError) {
    const retryAfter = (err as { retryAfter?: unknown }).retryAfter
    if (typeof retryAfter === 'number') {
      res.set('Retry-After', String(retryAfter))
    }
    const status = err.statusCode
    const error = safeErrorCategory(err.customErrorName, 'RoomPostRejected')
    res.status(status).json({
      error,
      message: safeRoomPostMessage(error, status),
    })
    return true
  }

  if (err instanceof StratosError) {
    const error = safeErrorCategory(err.code, 'RoomPostRejected')
    res.status(400).json({
      error,
      message: safeRoomPostMessage(error, 400),
    })
    return true
  }

  return false
}

/**
 * Create a Stratos-custody room post from a server-resolved room ID.
 * The request format deliberately has no boundary field.
 */
export const handleRoomPost = (
  config: OAuthRoutesConfig,
  authenticateRequest: (
    req: express.Request,
    res: express.Response,
  ) => Promise<string | null>,
) => {
  return async (req: express.Request, res: express.Response) => {
    try {
      const did = await authenticateRequest(req, res)
      if (!did) return

      const request = parseRoomPostRequest(req.body)
      if (!request) {
        res.status(400).json({
          error: 'InvalidRoomPost',
          message: 'A room ID and non-empty text are required',
        })
        return
      }

      if (!config.roomCatalog) {
        res.status(503).json({
          error: 'RoomCatalogUnavailable',
          message: 'Room posting is not configured for this service',
        })
        return
      }

      const room = config.roomCatalog.get(request.roomId)
      if (!room) {
        res.status(404).json({
          error: 'UnknownRoom',
          message: 'The requested room is not configured',
        })
        return
      }

      const enrollment = await config.enrollmentStore.getEnrollment(did)
      const memberBoundaries =
        enrollment?.active === true
          ? await config.enrollmentStore.getBoundaries(did)
          : []
      if (!memberBoundaries.includes(room.boundary)) {
        res.status(403).json({
          error: 'RoomMembershipRequired',
          message: 'Join this room before posting',
        })
        return
      }

      const result = await config.createApprovedRoomPost({
        did,
        boundary: room.boundary,
        text: request.text,
        ...(request.reply ? { reply: request.reply } : {}),
      })
      res.status(201).json(result)
    } catch (err) {
      if (sendRoomPostWriteError(res, err)) return
      config.logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'room post failed',
      )
      res.status(500).json({
        error: 'RoomPostError',
        message: 'Failed to create room post',
      })
    }
  }
}
