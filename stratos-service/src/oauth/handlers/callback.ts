import express from 'express'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import type {
  EnrollmentValidationResult,
  SpacesCapability,
  Logger,
} from '@northskysocial/stratos-core'
import type { EnrollmentStore, OAuthRoutesConfig } from '../routes.js'
import {
  migrateEnrollmentRkey,
  selectEnrollBoundaries,
  serviceDIDToRkey,
} from '../routes.js'
import { detectSpacesCapability } from '../spaces-capability.js'

export const handleCallback = (config: OAuthRoutesConfig) => {
  const {
    oauthClient,
    enrollmentStore,
    serviceEndpoint,
    serviceDid,
    defaultBoundaries = [],
    autoEnrollDomains,
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

      // Complete the OAuth flow. `state` carries the redirect target that
      // `handleAuthorize` verified before it started this flow.
      const { session, state } = await oauthClient.callback(params)
      const did = session.sub

      // Validate enrollment eligibility
      const enrollmentResult: EnrollmentValidationResult = {
        ...(await config.enrollmentValidator.validate(did)),
      }

      if (!enrollmentResult.allowed) {
        return denyEnrollment(res, did, enrollmentResult.reason, oauthClient)
      }

      // Read back the scope actually granted. A non-spaces PDS silently drops
      // the space scope `handleAuthorize` requested, so the grant (or its
      // absence) is the answer; a failed read is 'unknown', never a false
      // 'not-capable'.
      enrollmentResult.spacesCapability = await detectSpacesCapability(
        session,
        serviceDid,
        logger,
      )
      logger?.info(
        { did, spacesCapability: enrollmentResult.spacesCapability },
        'detected PDS spaces capability',
      )

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
          autoEnrollDomains,
          defaultBoundaries,
          spacesCapability: enrollmentResult.spacesCapability,
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
          spacesCapability: enrollmentResult.spacesCapability,
          logger,
        })
      }

      // Redirect back to the app if a redirect was stored, otherwise return JSON
      sendOAuthResponse({
        res,
        did,
        alreadyEnrolled,
        redirectTo: state,
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
  autoEnrollDomains: string[] | undefined
  defaultBoundaries: string[]
  spacesCapability: SpacesCapability | undefined
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
    spacesCapability,
    logger,
  } = deps

  // A re-auth can change the verdict, because the user may grant or withhold
  // the space scope each time. MM-03 reconciles the stored custody class.
  logger?.info({ did, spacesCapability }, 're-authorised existing enrollment')

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
    const currentBoundaries = await enrollmentStore.getBoundaries(did)
    const newBoundaries = selectEnrollBoundaries(
      deps.autoEnrollDomains,
      deps.defaultBoundaries,
    )

    const boundariesChanged =
      JSON.stringify(currentBoundaries.sort()) !==
      JSON.stringify(newBoundaries.sort())

    if (boundariesChanged) {
      await enrollmentStore.setBoundaries(did, newBoundaries)
      logger?.info({ did, newBoundaries }, 'updated enrollment boundaries')
    }

    const boundaries = boundariesChanged ? newBoundaries : currentBoundaries
    const attestation = await createAttestation(
      did,
      boundaries,
      enrollment.signingKeyDid,
    )

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
  spacesCapability: SpacesCapability | undefined
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
    spacesCapability,
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

  // Create enrollment record
  // MM-03 stores this as the custody class. Logged here so the verdict is
  // tied to the enrollment it decided, not to the callback that read it.
  logger?.info({ did, spacesCapability }, 'enrolling actor')

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

/**
 * Send the browser back to the calling app, or answer with JSON.
 *
 * The target arrives in the OAuth state, which `handleAuthorize` set only after
 * `verifyRedirectTarget` accepted it. The OAuth client keeps that value in the
 * `oauth_state` table, returns it to this callback alone, and deletes the row on
 * read, so the value is single-use and never passes through the browser. That
 * chain is the integrity boundary, so this function re-checks only the scheme
 * and does not repeat the client metadata fetch.
 *
 * The redirect carries `stratos_enrolled` and nothing else. No token, no
 * authorization code, and no DID ever rides this URL.
 */
function sendOAuthResponse(deps: {
  res: express.Response
  did: string
  alreadyEnrolled: boolean
  redirectTo: string | null
  allowedSchemes: string[]
  enrollBoundaries: string[]
  logger: Logger | undefined
}) {
  const {
    res,
    did,
    alreadyEnrolled,
    redirectTo,
    allowedSchemes,
    enrollBoundaries,
    logger,
  } = deps

  if (redirectTo) {
    try {
      const url = new URL(redirectTo)
      if (allowedSchemes.includes(url.protocol)) {
        url.searchParams.set('stratos_enrolled', 'true')
        return res.redirect(url.toString())
      }
      logger?.warn(
        { origin: url.origin },
        'stored redirect uses a disallowed scheme; answering with JSON',
      )
    } catch {
      logger?.warn(
        {},
        'stored redirect is not a valid URL; answering with JSON',
      )
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
