import express from 'express'
import { Agent } from '@atproto/api'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { IdResolver } from '@atproto/identity'
import type {
  EnrollmentConfig,
  EnrollmentValidator,
  Logger,
} from '@northskysocial/stratos-core'
import type { RequestHeaders } from '../infra/auth/index.js'

import { handleAuthorize } from './handlers/authorize.js'
import { handleCallback } from './handlers/callback.js'
import { handleStatus } from './handlers/status.js'
import { handleRevoke } from './handlers/revoke.js'

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
  getBoundaries(did: string): Promise<string[]>
  setBoundaries(did: string, boundaries: string[]): Promise<void>
  addBoundary(did: string, boundary: string): Promise<void>
  removeBoundary(did: string, boundary: string): Promise<void>
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
  enrollmentValidator: EnrollmentValidator
  idResolver: IdResolver
  baseUrl: string
  serviceEndpoint: string
  serviceDid: string
  defaultBoundaries?: string[]
  autoEnrollDomains?: string[]
  logger?: Logger
  devMode?: boolean
  dpopVerifier: import('../infra/auth/dpop-verifier.js').DpopVerifier
  profileRecordWriter: import('@northskysocial/stratos-core').ProfileRecordWriter
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
 *
 * @param did - The user's DID for which the enrollment record is being migrated.
 * @param enrollmentStore - The enrollment store where the user's enrollment records are stored.
 * @param oauthClient - The OAuth client used for authentication and authorization.
 * @param serviceEndpoint - The endpoint URL of the service.
 * @param serviceDid - The DID of the service.
 * @param profileRecordWriter - The profile record writer for updating user profiles.
 * @param logger - Optional logger for logging migration details.
 */
export async function migrateEnrollmentRkey(
  did: string,
  enrollmentStore: EnrollmentStore,
  oauthClient: NodeOAuthClient,
  serviceEndpoint: string,
  serviceDid: string,
  profileRecordWriter: import('@northskysocial/stratos-core').ProfileRecordWriter,
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
    await profileRecordWriter.putEnrollmentRecord(
      did,
      expectedRkey,
      matchingRecord.value as Record<string, unknown>,
    )

    // Delete the old record
    await profileRecordWriter.deleteEnrollmentRecord(did, currentRkey)

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
 * Get enrollment boundaries for a user
 * @param autoEnrollDomains - List of auto-enroll domains for the user
 * @param defaultBoundaries - Default boundaries to use if auto-enroll domains are not provided
 * @returns List of enrollment boundaries for the user
 */
export function selectEnrollBoundaries(
  autoEnrollDomains: string[] | undefined,
  defaultBoundaries: string[],
): string[] {
  return autoEnrollDomains && autoEnrollDomains.length > 0
    ? autoEnrollDomains
    : defaultBoundaries
}

/**
 * Create Express router for OAuth enrollment flow
 *
 * @param config - Configuration options for OAuth routes
 * @returns Express router for OAuth enrollment flow
 */
export function createOAuthRoutes(config: OAuthRoutesConfig): express.Router {
  const router = express.Router()
  const {
    defaultBoundaries = [],
    autoEnrollDomains,
    devMode = false,
    dpopVerifier,
  } = config
  selectEnrollBoundaries(autoEnrollDomains, defaultBoundaries)

  config.baseUrl.startsWith('https://')

  /**
   * Authenticate a request using DPoP (production) or Bearer DID (dev mode only).
   * Returns the authenticated DID, or null if the response was already sent.
   *
   * @param req - Express request object
   * @param res - Express response object
   * @returns Authenticated DID or null if response was already sent
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
          headers: req.headers as RequestHeaders,
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

  router.get('/authorize', handleAuthorize(config))

  router.get('/callback', handleCallback(config))

  router.get('/status', handleStatus(config, authenticateRequest))

  router.post('/revoke', handleRevoke(config, authenticateRequest))

  return router
}
