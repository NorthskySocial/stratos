import express from 'express'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import type { Logger } from '@northskysocial/stratos-core'
import type { EnrollmentStore, OAuthRoutesConfig } from '../routes.js'
import {
  migrateEnrollmentRkey,
  selectEnrollBoundaries,
  serviceDIDToRkey,
} from '../routes.js'
import { validateEnrollment } from '../../auth/index.js'

export const handleCallback = (config: OAuthRoutesConfig) => {
  const {
    oauthClient,
    enrollmentConfig,
    enrollmentStore,
    idResolver,
    serviceEndpoint,
    serviceDid,
    defaultBoundaries = [],
    autoEnrollDomains,
    allowListProvider,
    logger,
    devMode = false,
    profileRecordWriter,
    initRepo,
    createSigningKey,
    createAttestation,
  } = config

  const enrollBoundaries = selectEnrollBoundaries(
    autoEnrollDomains,
    defaultBoundaries,
  )

  const isSecure = config.baseUrl.startsWith('https://')
  const allowedSchemes = isSecure ? ['https:'] : ['http:', 'https:']

  return async (req: express.Request, res: express.Response) => {
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
        allowListProvider,
      )

      if (!enrollmentResult.allowed) {
        return denyEnrollment(res, did, enrollmentResult.reason, oauthClient)
      }

      // Check if already enrolled
      const alreadyEnrolled = await enrollmentStore.isEnrolled(did)

      if (alreadyEnrolled) {
        await handleExistingEnrollment({
          did,
          enrollmentStore,
          oauthClient,
          serviceEndpoint,
          serviceDid,
          profileRecordWriter,
          createAttestation,
          logger,
        })
      } else {
        await handleNewEnrollment({
          did,
          enrollmentStore,
          serviceEndpoint,
          serviceDid,
          profileRecordWriter,
          initRepo,
          createSigningKey,
          createAttestation,
          enrollBoundaries,
          pdsEndpoint: enrollmentResult.pdsEndpoint!,
          logger,
        })
      }

      // Redirect back to the app if a redirect was stored, otherwise return JSON
      sendOAuthResponse({
        req,
        res,
        did,
        alreadyEnrolled,
        allowedSchemes,
        enrollBoundaries,
        logger,
      })
    } catch (err) {
      handleCallbackError(res, err, logger, devMode)
    }
  }
}

async function denyEnrollment(
  res: express.Response,
  did: string,
  reason: string | undefined,
  oauthClient: NodeOAuthClient,
) {
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
    message: messages[reason!] || 'Enrollment denied',
  })
}

async function handleExistingEnrollment(deps: {
  did: string
  enrollmentStore: EnrollmentStore
  oauthClient: NodeOAuthClient
  serviceEndpoint: string
  serviceDid: string
  profileRecordWriter: OAuthRoutesConfig['profileRecordWriter']
  createAttestation: OAuthRoutesConfig['createAttestation']
  logger: Logger | undefined
}) {
  const {
    did,
    enrollmentStore,
    oauthClient,
    serviceEndpoint,
    serviceDid,
    profileRecordWriter,
    createAttestation,
    logger,
  } = deps

  // Migrate legacy (self-keyed or TID-keyed) enrollment record to service DID rkey
  await migrateEnrollmentRkey(
    did,
    enrollmentStore,
    oauthClient,
    serviceEndpoint,
    serviceDid,
    profileRecordWriter,
    logger,
  )

  // Ensure PDS record exists (in case user deleted it but stayed enrolled in Stratos)
  const enrollment = await enrollmentStore.getEnrollment(did)
  if (enrollment && enrollment.active) {
    const boundaries = await enrollmentStore.getBoundaries(did)
    const attestation = await createAttestation(
      did,
      boundaries,
      enrollment.signingKeyDid,
    )

    try {
      await profileRecordWriter.putEnrollmentRecord(
        did,
        enrollment.enrollmentRkey!,
        {
          service: serviceEndpoint,
          boundaries: boundaries.map((value: string) => ({ value })),
          signingKey: enrollment.signingKeyDid,
          attestation: {
            sig: attestation.sig,
            signingKey: attestation.signingKey,
          },
          createdAt: new Date().toISOString(),
        },
      )
    } catch (profileErr) {
      logger?.warn(
        {
          err:
            profileErr instanceof Error
              ? profileErr.message
              : String(profileErr),
          did,
        },
        'failed to restore profile record',
      )
    }
  }
}

async function handleNewEnrollment(deps: {
  did: string
  enrollmentStore: EnrollmentStore
  serviceEndpoint: string
  serviceDid: string
  profileRecordWriter: OAuthRoutesConfig['profileRecordWriter']
  initRepo: OAuthRoutesConfig['initRepo']
  createSigningKey: OAuthRoutesConfig['createSigningKey']
  createAttestation: OAuthRoutesConfig['createAttestation']
  enrollBoundaries: string[]
  pdsEndpoint: string
  logger: Logger | undefined
}) {
  const {
    did,
    enrollmentStore,
    serviceEndpoint,
    serviceDid,
    profileRecordWriter,
    initRepo,
    createSigningKey,
    createAttestation,
    enrollBoundaries,
    pdsEndpoint,
    logger,
  } = deps

  // Initialize actor store and repo with an empty signed commit
  await initRepo(did)

  // Generate user signing key and service attestation
  const userSigningKeyDid = await createSigningKey(did)
  const attestation = await createAttestation(
    did,
    enrollBoundaries,
    userSigningKeyDid,
  )

  // Write profile record to user's PDS for endpoint discovery
  // Uses putRecord with service DID as rkey for deterministic addressing
  const enrollmentRkey = serviceDIDToRkey(serviceDid)
  try {
    await profileRecordWriter.putEnrollmentRecord(did, enrollmentRkey, {
      service: serviceEndpoint,
      boundaries: enrollBoundaries.map((value: string) => ({ value })),
      signingKey: userSigningKeyDid,
      attestation: {
        sig: attestation.sig,
        signingKey: attestation.signingKey,
      },
      createdAt: new Date().toISOString(),
    })
  } catch (profileErr) {
    logger?.warn(
      {
        err:
          profileErr instanceof Error ? profileErr.message : String(profileErr),
        did,
      },
      'failed to write profile record',
    )
  }

  // Create enrollment record
  await enrollmentStore.enroll({
    did,
    enrolledAt: new Date().toISOString(),
    pdsEndpoint,
    boundaries: enrollBoundaries,
    signingKeyDid: userSigningKeyDid,
    active: true,
    enrollmentRkey,
  })
}

function sendOAuthResponse(deps: {
  req: express.Request
  res: express.Response
  did: string
  alreadyEnrolled: boolean
  allowedSchemes: string[]
  enrollBoundaries: string[]
  logger: Logger | undefined
}) {
  const {
    req,
    res,
    did,
    alreadyEnrolled,
    allowedSchemes,
    enrollBoundaries,
    logger,
  } = deps

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
      { did, boundaryCount: enrollBoundaries.length },
      'user enrolled via OAuth',
    )
  }
}

function handleCallbackError(
  res: express.Response,
  err: unknown,
  logger: Logger | undefined,
  devMode: boolean,
) {
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
