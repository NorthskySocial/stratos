import express from 'express'
import { Agent } from '@atproto/api'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { IdResolver } from '@atproto/identity'
import type { Logger } from '@northskysocial/stratos-core'
import { EnrollmentConfig, validateEnrollment } from '../auth/enrollment.js'
import { OAUTH_SCOPE } from './client.js'

/**
 * Converts a service DID to a valid AT Protocol record key.
 * Replaces percent-encoded colons (%3A) with literal colons,
 * which are valid rkey characters.
 */
export function serviceDIDToRkey(serviceDid: string): string {
  return serviceDid.replace(/%3A/gi, ':')
}

/**
 * Enrollment record stored in database
 */
export interface EnrollmentRecord {
  did: string
  enrolledAt: string
  pdsEndpoint?: string
  boundaries?: string[]
  signingKeyDid: string
  active: boolean
  enrollmentRkey?: string
}

/**
 * Enrollment store interface
 */
export interface EnrollmentStore {
  isEnrolled(did: string): Promise<boolean>
  enroll(record: EnrollmentRecord): Promise<void>
  unenroll(did: string): Promise<void>
  getEnrollment(did: string): Promise<EnrollmentRecord | null>
  updateEnrollment(
    did: string,
    updates: Partial<Omit<EnrollmentRecord, 'did'>>,
  ): Promise<void>
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
  serviceEndpoint: string
  serviceDid: string
  defaultBoundaries?: string[]
  logger?: Logger
  devMode?: boolean
  dpopVerifier: import('../auth/dpop-verifier.js').DpopVerifier
  initRepo: (did: string) => Promise<void>
  createSigningKey: (did: string) => Promise<string>
  createAttestation: (
    did: string,
    boundaries: string[],
    userDidKey: string,
  ) => Promise<{ sig: Uint8Array; signingKey: string }>
}

/**
 * Migrate a legacy enrollment record (self-keyed or TID-keyed) to use
 * the service DID as the rkey. On re-auth, lists the user's PDS enrollment
 * records, finds the one matching this service, and re-writes it with the
 * service DID rkey if needed.
 */
export async function migrateEnrollmentRkey(
  did: string,
  enrollmentStore: EnrollmentStore,
  oauthClient: NodeOAuthClient,
  serviceEndpoint: string,
  serviceDid: string,
  logger?: Logger,
): Promise<void> {
  const expectedRkey = serviceDIDToRkey(serviceDid)
  const existing = await enrollmentStore.getEnrollment(did)
  if (!existing) return

  // Already using the correct rkey
  if (existing.enrollmentRkey === expectedRkey) return

  try {
    const oauthSession = await oauthClient.restore(did)
    const agent = new Agent(oauthSession)

    const listRes = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      limit: 100,
    })

    const normalizedEndpoint = serviceEndpoint.replace(/\/$/, '')
    const matchingRecord = listRes.data.records.find((r) => {
      const val = r.value as Record<string, unknown>
      return (
        typeof val.service === 'string' &&
        val.service.replace(/\/$/, '') === normalizedEndpoint
      )
    })

    if (!matchingRecord) return

    const currentRkey = matchingRecord.uri.split('/').pop()!

    if (currentRkey === expectedRkey) {
      // PDS record already has correct rkey, just sync the DB
      await enrollmentStore.updateEnrollment(did, {
        enrollmentRkey: expectedRkey,
      })
      return
    }

    // Write record with service DID rkey
    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey: expectedRkey,
      record: matchingRecord.value as Record<string, unknown>,
    })

    // Delete the old record
    await agent.com.atproto.repo.deleteRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey: currentRkey,
    })

    await enrollmentStore.updateEnrollment(did, {
      enrollmentRkey: expectedRkey,
    })

    logger?.info(
      { did, oldRkey: currentRkey, newRkey: expectedRkey },
      'migrated enrollment record to service DID rkey',
    )
  } catch (err) {
    logger?.warn(
      { did, err: err instanceof Error ? err.message : String(err) },
      'failed to migrate legacy enrollment rkey',
    )
  }
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
    serviceEndpoint,
    serviceDid,
    defaultBoundaries = [],
    logger,
    devMode = false,
    dpopVerifier,
    initRepo,
    createSigningKey,
    createAttestation,
  } = config

  const isSecure = config.baseUrl.startsWith('https://')

  const allowedSchemes = isSecure ? ['https:'] : ['http:', 'https:']

  /**
   * Authenticate a request using DPoP (production) or Bearer DID (dev mode only).
   * Returns the authenticated DID, or null if the response was already sent.
   */
  async function authenticateRequest(
    req: express.Request,
    res: express.Response,
  ): Promise<string | null> {
    const authHeader = req.headers.authorization
    if (!authHeader) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization required',
      })
      return null
    }

    if (devMode && authHeader.startsWith('Bearer ')) {
      const did = authHeader.slice(7).trim()
      if (did.startsWith('did:')) {
        return did
      }
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token format',
      })
      return null
    }

    if (!authHeader.startsWith('DPoP ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'DPoP authorization required',
      })
      return null
    }

    try {
      const result = await dpopVerifier.verify(
        {
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers as Record<string, string | string[] | undefined>,
        },
        {
          setHeader: (name: string, value: string) =>
            res.setHeader(name, value),
        },
      )
      return result.did
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'DPoP verification failed'
      res.status(401).json({
        error: 'Unauthorized',
        message,
      })
      return null
    }
  }

  /**
   * Start OAuth authorization flow
   * GET /oauth/authorize?handle=user.bsky.social
   */
  router.get('/authorize', async (req, res) => {
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
        try {
          const parsed = new URL(redirectUri)
          if (!allowedSchemes.includes(parsed.protocol)) {
            return res.status(400).json({
              error: 'InvalidRequest',
              message: 'redirect_uri must use https',
            })
          }
        } catch {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'Invalid redirect_uri',
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
          NotInAllowlist:
            'Your account is not eligible for this Stratos service',
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

      if (alreadyEnrolled) {
        // Migrate legacy (self-keyed or TID-keyed) enrollment record to service DID rkey
        await migrateEnrollmentRkey(
          did,
          enrollmentStore,
          oauthClient,
          serviceEndpoint,
          serviceDid,
          logger,
        )
      }

      if (!alreadyEnrolled) {
        // Initialize actor store and repo with an empty signed commit
        await initRepo(did)

        // Generate user signing key and service attestation
        const userSigningKeyDid = await createSigningKey(did)
        const attestation = await createAttestation(
          did,
          defaultBoundaries,
          userSigningKeyDid,
        )

        // Write profile record to user's PDS for endpoint discovery
        // Uses putRecord with service DID as rkey for deterministic addressing
        const enrollmentRkey = serviceDIDToRkey(serviceDid)
        try {
          const oauthSession = await oauthClient.restore(did)
          const agent = new Agent(oauthSession)

          await agent.com.atproto.repo.putRecord({
            repo: did,
            collection: 'zone.stratos.actor.enrollment',
            rkey: enrollmentRkey,
            record: {
              service: serviceEndpoint,
              boundaries: defaultBoundaries.map((value) => ({ value })),
              signingKey: userSigningKeyDid,
              attestation: {
                sig: attestation.sig,
                signingKey: attestation.signingKey,
              },
              createdAt: new Date().toISOString(),
            },
          })
        } catch (profileErr) {
          logger?.warn(
            {
              err:
                profileErr instanceof Error
                  ? profileErr.message
                  : String(profileErr),
              did,
            },
            'failed to write profile record',
          )
        }

        // Create enrollment record
        await enrollmentStore.enroll({
          did,
          enrolledAt: new Date().toISOString(),
          pdsEndpoint: enrollmentResult.pdsEndpoint,
          boundaries: defaultBoundaries,
          signingKeyDid: userSigningKeyDid,
          active: true,
          enrollmentRkey,
        })
      }

      // Redirect back to the app if a redirect was stored, otherwise return JSON
      const redirectTo = (
        req as express.Request & { cookies?: Record<string, string> }
      ).cookies?.stratos_redirect
      if (redirectTo) {
        res.clearCookie('stratos_redirect')
        try {
          const url = new URL(redirectTo)
          if (allowedSchemes.includes(url.protocol)) {
            url.searchParams.set('stratos_enrolled', 'true')
            return res.redirect(url.toString())
          }
        } catch {
          // Invalid URL, fall through to JSON response
        }
      }

      res.json({
        success: true,
        did,
        enrolled: !alreadyEnrolled,
        message: alreadyEnrolled
          ? 'Already enrolled in Stratos'
          : 'Successfully enrolled in Stratos',
      })

      if (!alreadyEnrolled) {
        logger?.info(
          { did, boundaryCount: defaultBoundaries.length },
          'user enrolled via OAuth',
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errStack = err instanceof Error ? err.stack : undefined
      logger?.error({ err: errMsg, stack: errStack }, 'OAuth callback failed')
      console.error('OAuth callback failed:', errMsg)
      if (errStack) console.error(errStack)
      res.status(500).json({
        error: 'CallbackError',
        message: devMode ? errMsg : 'Failed to complete authorization',
      })
    }
  })

  /**
   * Check enrollment status
   * GET /oauth/status
   */
  router.get('/status', async (req, res) => {
    try {
      const did = await authenticateRequest(req, res)
      if (!did) return

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
      const did = await authenticateRequest(req, res)
      if (!did) return

      // Check if enrolled
      const currentEnrollment = await enrollmentStore.getEnrollment(did)
      if (!currentEnrollment) {
        return res.status(404).json({
          error: 'NotFound',
          message: 'User is not enrolled',
        })
      }

      // Best-effort PDS enrollment record deletion using stored rkey or service DID
      const rkey =
        currentEnrollment.enrollmentRkey || serviceDIDToRkey(serviceDid)
      try {
        const oauthSession = await oauthClient.restore(did)
        const agent = new Agent(oauthSession)
        await agent.com.atproto.repo.deleteRecord({
          repo: did,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
        })
      } catch (err) {
        logger?.warn(
          { err: err instanceof Error ? err.message : String(err), did },
          'failed to delete PDS enrollment record',
        )
      }

      // Remove boundaries and mark enrollment inactive (signing key is preserved)
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
