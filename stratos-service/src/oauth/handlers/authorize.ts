import express from 'express'
import { OAUTH_SCOPE } from '../client.js'
import { verifyRedirectTarget } from '../redirect-target.js'
import type { OAuthRoutesConfig } from '../routes.js'

/**
 * Tells a client developer how to make its own redirect target acceptable.
 *
 * A rejection here is almost always a client that did not send `client_id`,
 * so the message names the fix instead of only the failure.
 */
const HOW_TO_PROVE_REDIRECT =
  'Publish a client metadata document that declares this redirect_uri, then pass its URL as client_id.'

/**
 * Handles the OAuth authorization flow
 *
 * @param config - OAuth routes configuration
 * @returns Express handler function
 */
export const handleAuthorize = (config: OAuthRoutesConfig) => {
  const { oauthClient, logger } = config

  const isSecure = config.baseUrl.startsWith('https://')
  const redirectGates = {
    allowedSchemes: isSecure ? ['https:'] : ['http:', 'https:'],
    allowedRedirectOrigins: config.allowedRedirectOrigins,
    devMode: config.devMode ?? false,
  }

  return async (req: express.Request, res: express.Response) => {
    try {
      const handle = req.query.handle as string
      const redirectUri = req.query.redirect_uri as string | undefined
      const clientId = req.query.client_id as string | undefined

      if (!handle) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'Handle parameter required',
        })
      }

      if (redirectUri) {
        const verdict = await verifyRedirectTarget(
          redirectUri,
          clientId,
          redirectGates,
          config.fetchClientRedirectUris,
        )
        if (!verdict.allowed) {
          logger?.warn(
            { clientId, message: verdict.message },
            'rejected enrollment redirect_uri',
          )
          return res.status(400).json({
            error: 'InvalidRequest',
            message: verdict.message,
            hint: HOW_TO_PROVE_REDIRECT,
          })
        }

        res.cookie('stratos_redirect', redirectUri, {
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 10 * 60 * 1000,
          secure: isSecure,
        })
      }

      // Start the authorization flow
      logger?.debug(
        { handle, scope: OAUTH_SCOPE },
        'Starting OAuth authorization',
      )
      const authUrl = await oauthClient.authorize(handle, {
        scope: OAUTH_SCOPE,
      })

      // Redirect user to their PDS for authorization
      res.redirect(authUrl.toString())
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const errorStack = err instanceof Error ? err.stack : undefined
      logger?.error(
        { err: errorMsg, stack: errorStack, handle: req.query.handle },
        'OAuth authorize failed',
      )
      console.error('OAuth authorize failed:', errorMsg, errorStack)

      // Check for common error types from @atproto/oauth-client-node
      // Handle resolution or PDS discovery failures should be 400
      const isResolutionError =
        errorMsg.toLowerCase().includes('resolve') ||
        errorMsg.toLowerCase().includes('handle') ||
        errorMsg.toLowerCase().includes('did') ||
        errorMsg.toLowerCase().includes('discovery')

      res.status(isResolutionError ? 400 : 500).json({
        error: 'AuthorizationError',
        message: config.devMode
          ? `Failed to start authorization flow: ${errorMsg}`
          : 'Failed to start authorization flow',
      })
    }
  }
}
