import express from 'express'
import { isAllowedRedirectOrigin } from '../../config.js'
import { OAUTH_SCOPE } from '../client.js'
import type { OAuthRoutesConfig } from '../routes.js'

/**
 * Check a client-supplied `redirect_uri` against the scheme and origin gates.
 *
 * @param redirectUri - The raw `redirect_uri` query parameter
 * @param gates - Permitted URL schemes, allow-listed origins, and dev-mode flag
 * @returns A client-facing rejection message, or null if the URI is acceptable
 */
function rejectRedirectUri(
  redirectUri: string,
  gates: {
    allowedSchemes: string[]
    allowedRedirectOrigins: string[]
    devMode: boolean
  },
): string | null {
  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  } catch {
    return 'Invalid redirect_uri'
  }

  if (!gates.allowedSchemes.includes(parsed.protocol)) {
    return 'redirect_uri must use https'
  }

  if (!isAllowedRedirectOrigin(redirectUri, gates)) {
    return 'redirect_uri origin is not allowed'
  }

  return null
}

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

      if (!handle) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'Handle parameter required',
        })
      }

      if (redirectUri) {
        const rejection = rejectRedirectUri(redirectUri, redirectGates)
        if (rejection) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: rejection,
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
