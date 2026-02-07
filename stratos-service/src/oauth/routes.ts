import express from 'express'
import { Agent } from '@atproto/api'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { IdResolver } from '@atproto/identity'
import type { Logger } from '@anthropic/stratos-core'
import {
  EnrollmentConfig,
  validateEnrollment,
  EnrollmentDeniedError,
} from '../auth/enrollment.js'

/**
 * Enrollment record stored in database
 */
export interface EnrollmentRecord {
  did: string
  enrolledAt: string
  pdsEndpoint?: string
  boundaries?: string[]
}

/**
 * Enrollment store interface
 */
export interface EnrollmentStore {
  isEnrolled(did: string): Promise<boolean>
  enroll(record: EnrollmentRecord): Promise<void>
  unenroll(did: string): Promise<void>
  getEnrollment(did: string): Promise<EnrollmentRecord | null>
}

/**
 * Configuration for OAuth routes
 */
export interface OAuthRoutesConfig {
  oauthClient: NodeOAuthClient
  enrollmentConfig: EnrollmentConfig
  enrollmentStore: EnrollmentStore
  idResolver: IdResolver
  baseUrl: string
  /** The public service endpoint URL for this Stratos service */
  serviceEndpoint: string
  /** Boundaries to assign to new enrollments (if empty, placeholder will be used) */
  defaultBoundaries?: string[]
  /** Logger for OAuth events */
  logger?: Logger
}

/**
 * Create Express router for OAuth enrollment flow
 */
export function createOAuthRoutes(config: OAuthRoutesConfig): express.Router {
  const router = express.Router()
  const {
    oauthClient,
    enrollmentConfig,
    enrollmentStore,
    idResolver,
    baseUrl,
    serviceEndpoint,
    defaultBoundaries = [],
    logger,
  } = config

  /**
   * Start OAuth authorization flow
   * GET /oauth/authorize?handle=user.bsky.social
   */
  router.get('/authorize', async (req, res) => {
    try {
      const handle = req.query.handle as string

      if (!handle) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: 'Handle parameter required',
        })
      }

      // Start authorization flow
      const authUrl = await oauthClient.authorize(handle, {
        scope: 'atproto transition:generic',
      })

      // Redirect user to their PDS for authorization
      res.redirect(authUrl.toString())
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err), handle: req.query.handle },
        'OAuth authorize failed',
      )
      res.status(500).json({
        error: 'AuthorizationError',
        message: 'Failed to start authorization flow',
      })
    }
  })

  /**
   * OAuth callback handler
   * GET /oauth/callback
   */
  router.get('/callback', async (req, res) => {
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '')

      // Complete the OAuth flow
      const { session } = await oauthClient.callback(params)
      const did = session.sub

      // Validate enrollment eligibility
      const enrollmentResult = await validateEnrollment(
        enrollmentConfig,
        did,
        idResolver,
      )

      if (!enrollmentResult.allowed) {
        // Clean up the session since enrollment is not allowed
        await oauthClient.revoke(did)

        const messages: Record<string, string> = {
          NotInAllowlist: 'Your account is not eligible for this Stratos service',
          DidNotResolved: 'Could not verify your identity',
          PdsEndpointNotFound: 'Could not find your PDS endpoint',
          ServiceClosed: 'This service is not accepting new enrollments',
        }

        return res.status(403).json({
          error: 'EnrollmentDenied',
          message: messages[enrollmentResult.reason!] || 'Enrollment denied',
        })
      }

      // Check if already enrolled
      const alreadyEnrolled = await enrollmentStore.isEnrolled(did)

      if (!alreadyEnrolled) {
        // Create enrollment record
        await enrollmentStore.enroll({
          did,
          enrolledAt: new Date().toISOString(),
          pdsEndpoint: enrollmentResult.pdsEndpoint,
          boundaries: defaultBoundaries,
        })

        // Write profile record to user's PDS for endpoint discovery
        try {
          const oauthSession = await oauthClient.restore(did)
          const agent = new Agent(oauthSession)
          
          await agent.com.atproto.repo.putRecord({
            repo: did,
            collection: 'app.stratos.actor.enrollment',
            rkey: 'self',
            record: {
              service: serviceEndpoint,
              boundaries: defaultBoundaries.map(value => ({ value })),
              createdAt: new Date().toISOString(),
            },
          })
        } catch (profileErr) {
          logger?.warn(
            { err: profileErr instanceof Error ? profileErr.message : String(profileErr), did },
            'failed to write profile record',
          )
        }
      }

      // Return success page or redirect to app
      res.json({
        success: true,
        did,
        enrolled: !alreadyEnrolled,
        message: alreadyEnrolled
          ? 'Already enrolled in Stratos'
          : 'Successfully enrolled in Stratos',
      })

      if (!alreadyEnrolled) {
        logger?.info({ did, boundaryCount: defaultBoundaries.length }, 'user enrolled via OAuth')
      }
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'OAuth callback failed',
      )
      res.status(500).json({
        error: 'CallbackError',
        message: 'Failed to complete authorization',
      })
    }
  })

  /**
   * Check enrollment status
   * GET /oauth/status
   */
  router.get('/status', async (req, res) => {
    try {
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token required',
        })
      }

      // Extract DID from bearer token (format: "Bearer did:plc:xxx")
      const token = authHeader.slice(7) // Remove "Bearer "
      if (!token.startsWith('did:')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid token format: expected DID',
        })
      }

      const did = token

      // Validate session exists (optional, for extra security)
      if (oauthClient) {
        try {
          await oauthClient.restore(did, false)
        } catch {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'No valid session for user',
          })
        }
      }

      // Check enrollment status
      const enrollment = await enrollmentStore.getEnrollment(did)
      
      if (!enrollment) {
        return res.json({
          did,
          enrolled: false,
        })
      }

      res.json({
        did,
        enrolled: true,
        enrolledAt: enrollment.enrolledAt,
        boundaries: defaultBoundaries,
      })
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'status check failed',
      )
      res.status(500).json({
        error: 'StatusError',
        message: 'Failed to check status',
      })
    }
  })

  /**
   * Revoke enrollment (unenroll)
   * POST /oauth/revoke
   */
  router.post('/revoke', async (req, res) => {
    try {
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token required',
        })
      }

      // Extract DID from bearer token (format: "Bearer did:plc:xxx")
      const token = authHeader.slice(7) // Remove "Bearer "
      if (!token.startsWith('did:')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid token format: expected DID',
        })
      }

      const did = token

      // Validate session exists
      if (oauthClient) {
        try {
          await oauthClient.restore(did, false)
        } catch {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'No valid session for user',
          })
        }
      }

      // Check if enrolled
      const isEnrolled = await enrollmentStore.isEnrolled(did)
      if (!isEnrolled) {
        return res.status(404).json({
          error: 'NotFound',
          message: 'User is not enrolled',
        })
      }

      // Unenroll the user
      await enrollmentStore.unenroll(did)

      // Revoke the OAuth session if client available
      if (oauthClient) {
        try {
          await oauthClient.revoke(did)
        } catch (err) {
          logger?.warn(
            { err: err instanceof Error ? err.message : String(err), did },
            'failed to revoke OAuth session',
          )
        }
      }

      logger?.info({ did }, 'user unenrolled via OAuth')

      res.json({
        did,
        revoked: true,
        message: 'Successfully unenrolled from Stratos',
      })
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        'revoke failed',
      )
      res.status(500).json({
        error: 'RevokeError',
        message: 'Failed to revoke enrollment',
      })
    }
  })

  return router
}
