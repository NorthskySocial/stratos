import express from 'express'
import type { AdminAuthRoutesConfig } from '../admin-routes.js'
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS } from '../admin-routes.js'

/**
 * The part of a request this handler reads.
 *
 * `express.Request` satisfies it, and the contract is small enough for a caller
 * to supply one without a cast.
 */
export type AdminCallbackRequest = Pick<express.Request, 'url'>

/**
 * The response methods this handler calls.
 *
 * `express.Response` satisfies this. Declaring the methods rather than picking
 * them from `express.Response` keeps `status()` returning only what the handler
 * chains onto, so a test double needs no cast either.
 */
export interface AdminCallbackResponse {
  cookie(name: string, value: string, options: express.CookieOptions): unknown
  redirect(url: string): unknown
  status(code: number): { json(body: unknown): unknown }
  json(body: unknown): unknown
}

/**
 * Completes the admin OAuth flow.
 *
 * Unlike the enrollment callback, this performs no repo init, signing-key
 * creation, attestation, or PDS record write. It only:
 *  1. completes the token exchange and reads the authenticated DID,
 *  2. enforces the admin DID allowlist (revoking the OAuth session on miss),
 *  3. establishes an opaque server-side web session via an HttpOnly cookie.
 */
export const handleAdminCallback = (config: AdminAuthRoutesConfig) => {
  const { oauthClient, adminSessionStore, adminDids, baseUrl, logger } = config
  const isSecure = baseUrl.startsWith('https://')
  const adminRedirectUri = `${baseUrl}/admin/oauth/callback`

  return async (req: AdminCallbackRequest, res: AdminCallbackResponse) => {
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '')

      // The authorize step pinned this same redirect_uri; the token exchange
      // must echo it or the AS rejects the grant (invalid_grant). Without it
      // the client falls back to the first registered redirect_uri (the
      // enrollment callback), which never matches.
      type CallbackOptions = NonNullable<
        Parameters<typeof oauthClient.callback>[1]
      >
      const { session } = await oauthClient.callback(params, {
        redirect_uri: adminRedirectUri as CallbackOptions['redirect_uri'],
      })
      const did = session.sub

      if (!adminDids.includes(did)) {
        await oauthClient.revoke(did)
        logger?.warn({ did }, 'admin login rejected: DID not in allowlist')
        return res.status(403).json({
          error: 'NotAdmin',
          message: 'This account is not authorized for admin access',
        })
      }

      const sessionKey = await adminSessionStore.create(
        did,
        ADMIN_SESSION_TTL_MS,
      )

      res.cookie(ADMIN_SESSION_COOKIE, sessionKey, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'strict',
        maxAge: ADMIN_SESSION_TTL_MS,
        path: '/',
      })

      logger?.info({ adminDid: did }, 'admin session established')
      res.redirect('/admin')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger?.error({ err: errMsg }, 'admin OAuth callback failed')
      res.status(500).json({
        error: 'CallbackError',
        message: config.devMode ? errMsg : 'Failed to complete admin login',
      })
    }
  }
}
