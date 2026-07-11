import express from 'express'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import type { Logger } from '@northskysocial/stratos-core'
import type { AdminSessionStore } from './admin-session-store.js'
import { passesAdminCsrfCheck } from '../config.js'
import { handleAdminAuthorize } from './handlers/admin-authorize.js'
import { handleAdminCallback } from './handlers/admin-callback.js'

/**
 * Name of the cookie holding the opaque admin web-session id. The cookie never
 * carries the OAuth token — only the server-side session lookup key.
 */
export const ADMIN_SESSION_COOKIE = 'stratos_admin_session'

/**
 * Read the opaque admin session id straight from the request's `Cookie`
 * header.
 *
 * This deliberately parses the raw header rather than reading `req.cookies`.
 * The latter only exists after the `cookie-parser` middleware has run; a
 * reordering would make `req.cookies` `undefined` and silently log every admin
 * out (the failure the type cast masked). Reading the header directly has no
 * such ordering dependency, and the same accessor serves both the Express
 * routes here and the raw `IncomingMessage` admin auth verifier.
 */
export function readAdminSessionCookie(
  req: import('node:http').IncomingMessage,
): string | undefined {
  const cookieHeader = req.headers?.cookie
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === ADMIN_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}

/**
 * Lifetime of an admin web session.
 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Configuration for the admin OAuth authorization routes.
 */
export interface AdminAuthRoutesConfig {
  oauthClient: NodeOAuthClient
  adminSessionStore: AdminSessionStore
  adminDids: string[]
  baseUrl: string
  devMode?: boolean
  logger?: Logger
}

/**
 * Resolve the admin DID from the request's session cookie, or null if there is
 * no valid, unexpired session whose DID is still on the allowlist.
 */
export async function resolveAdminSession(
  req: express.Request,
  config: Pick<AdminAuthRoutesConfig, 'adminSessionStore' | 'adminDids'>,
): Promise<string | null> {
  const sessionKey = readAdminSessionCookie(req)
  if (!sessionKey) return null

  const session = await config.adminSessionStore.get(sessionKey)
  if (!session) return null
  if (!config.adminDids.includes(session.did)) return null

  return session.did
}

/**
 * Create the Express router for admin OAuth authorization.
 *
 * Mounted at `/admin/oauth` (plus the `/admin/whoami` convenience route).
 */
export function createAdminAuthRoutes(
  config: AdminAuthRoutesConfig,
): express.Router {
  const router = express.Router()
  const { adminSessionStore, baseUrl } = config
  const isSecure = baseUrl.startsWith('https://')
  const csrfDeps = { publicUrl: baseUrl, devMode: config.devMode ?? false }

  router.get('/oauth/authorize', handleAdminAuthorize(config))
  router.get('/oauth/callback', handleAdminCallback(config))

  router.get('/whoami', async (req, res) => {
    if (!passesAdminCsrfCheck(req, csrfDeps)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Cross-origin admin request rejected',
      })
    }

    const did = await resolveAdminSession(req, config)
    if (!did) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No active admin session',
      })
    }
    res.json({ did, isAdmin: true })
  })

  router.post('/oauth/logout', async (req, res) => {
    if (!passesAdminCsrfCheck(req, csrfDeps)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Cross-origin admin request rejected',
      })
    }

    const sessionKey = readAdminSessionCookie(req)
    if (sessionKey) {
      await adminSessionStore.del(sessionKey)
    }
    res.clearCookie(ADMIN_SESSION_COOKIE, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      path: '/',
    })
    res.json({ success: true })
  })

  return router
}
