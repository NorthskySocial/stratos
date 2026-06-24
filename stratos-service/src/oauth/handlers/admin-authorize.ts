import express from 'express'
import { OAUTH_ADMIN_SCOPE } from '../client.js'
import type { AdminAuthRoutesConfig } from '../admin-routes.js'

/**
 * Starts the admin OAuth authorization flow.
 *
 * Requests identity-only `atproto` scope (no repo writes) and pins the
 * authorization to the admin callback redirect URI so the enrollment callback
 * is never reached. Allowlist enforcement happens in the callback, not here.
 */
export const handleAdminAuthorize = (config: AdminAuthRoutesConfig) => {
  const { oauthClient, baseUrl, logger } = config
  const adminRedirectUri = `${baseUrl}/admin/oauth/callback`

  return async (req: express.Request, res: express.Response) => {
    try {
      const handle = req.query.handle as string | undefined
      if (!handle) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'Handle parameter required',
        })
      }

      logger?.debug({ handle }, 'starting admin OAuth authorization')
      type AuthorizeOptions = NonNullable<
        Parameters<typeof oauthClient.authorize>[1]
      >
      const authUrl = await oauthClient.authorize(handle, {
        scope: OAUTH_ADMIN_SCOPE,
        redirect_uri: adminRedirectUri as AuthorizeOptions['redirect_uri'],
      })

      res.redirect(authUrl.toString())
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger?.error(
        { err: errorMsg, handle: req.query.handle },
        'admin OAuth authorize failed',
      )

      const isResolutionError =
        errorMsg.toLowerCase().includes('resolve') ||
        errorMsg.toLowerCase().includes('handle') ||
        errorMsg.toLowerCase().includes('did') ||
        errorMsg.toLowerCase().includes('discovery')

      res.status(isResolutionError ? 400 : 500).json({
        error: 'AuthorizationError',
        message: config.devMode
          ? `Failed to start admin authorization: ${errorMsg}`
          : 'Failed to start admin authorization',
      })
    }
  }
}
