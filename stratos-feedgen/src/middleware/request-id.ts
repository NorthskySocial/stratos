import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

export interface RequestContext {
  requestId: string
  viewerDid?: string
}

const REQUEST_ID_HEADER = 'x-request-id'
const MAX_REQUEST_ID_LENGTH = 64

const als = new AsyncLocalStorage<RequestContext>()

/** Read the ambient request context; undefined outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore()
}

/**
 * The inbound header is attacker-controlled and gets logged, so strip
 * everything outside a safe charset and cap the length before use.
 */
export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, MAX_REQUEST_ID_LENGTH)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Accept an inbound `X-Request-Id` (sanitized) or generate a UUID, echo it on
 * the response, and expose it to downstream handlers via AsyncLocalStorage.
 */
export function requestIdMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId =
      sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID()
    res.setHeader('X-Request-Id', requestId)
    als.run({ requestId }, next)
  }
}
