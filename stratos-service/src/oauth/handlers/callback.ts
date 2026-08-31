import express from 'express'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import type { IdResolver } from '@atproto/identity'
import {
  classifyCustody,
  reconcileCustody,
  type Custody,
  type EnrollmentValidationResult,
  type Logger,
  type SpacesCapability,
} from '@northskysocial/stratos-core'
import type { EnrollmentStore, OAuthRoutesConfig } from '../routes.js'
import {
  migrateEnrollmentRkey,
  resolveAtprotoIdentity,
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
    idResolver,
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
      const enrollmentResult: EnrollmentValidationResult =
        await config.enrollmentValidator.validate(did)

      if (!enrollmentResult.allowed) {
        return denyEnrollment(res, did, enrollmentResult.reason, oauthClient)
      }

      // Read back the scope actually granted. A non-spaces PDS silently drops
      // the space scope `handleAuthorize` requested, so the grant (or its
      // absence) is the answer; a failed read is 'unknown', never a false
      // 'not-capable'.
      const spacesCapability = await detectSpacesCapability(
        session,
        serviceDid,
        logger,
      )
      logger?.info({ did, spacesCapability }, 'detected PDS spaces capability')

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
          spacesCapability,
          pdsEndpoint: enrollmentResult.pdsEndpoint,
          idResolver,
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
          idResolver,
          enrollBoundaries,
          pdsEndpoint: enrollmentResult.pdsEndpoint!,
          spacesCapability,
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
  /**
   * Resolved this request, not the stored value. Absent in open mode, where
   * eligibility returns before the DID document is resolved.
   */
  pdsEndpoint: string | undefined
  idResolver: IdResolver
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
    idResolver,
    logger,
  } = deps

  // A re-auth can change the verdict, because the user may grant or withhold
  // the space scope each time.
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
    // Open-mode eligibility returns an allowed result with no PDS endpoint.
    // Resolve it from the DID document instead of publishing `undefined`: a
    // pds-custody re-auth would publish `repoHost: undefined` and clear the
    // stored route. A failed resolution fails the callback closed, so no
    // absent endpoint is ever published or stored.
    const pdsEndpoint =
      deps.pdsEndpoint ??
      (await resolveAtprotoIdentity(did, idResolver)).pdsEndpoint

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

    // Rows persisted before MM-03 carry no custody; treat them as 'stratos'
    // custody so re-auth starts from the same invariant a fresh enrollment would.
    const storedCustody: Custody = enrollment.custody ?? 'stratos'
    // Re-auth never changes custody. A custody change is a data migration,
    // not a label change: the repo has to move and the signing key has to
    // change with it. Neither happens here, and flipping the label alone
    // would publish an enrollment whose `signingKey` contradicts its
    // `custody`. Record what we observed, keep the stored class, and let
    // MM-10 move anyone who has diverged.
    const custody = storedCustody
    const wantedCustody = reconcileCustody(storedCustody, spacesCapability)
    const custodyDiverged = wantedCustody !== storedCustody
    // 'pds' custody hosts the repo at the user's own PDS. Use the endpoint
    // resolved this request, not the stored one, so a user who moved PDS
    // gets their new host published instead of a stale routing target.
    // 'stratos' custody has no repoHost.
    const repoHost = custody === 'pds' ? pdsEndpoint : undefined
    const pdsEndpointChanged = pdsEndpoint !== enrollment.pdsEndpoint

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
        custody,
        repoHost,
      },
    )

    const verdictChanged = spacesCapability !== enrollment.capabilityVerdict
    if (verdictChanged || pdsEndpointChanged) {
      await enrollmentStore.updateEnrollment(did, {
        ...(verdictChanged ? { capabilityVerdict: spacesCapability } : {}),
        // `repoHost` is the routing target, so it moves with the endpoint.
        // Publishing the new host while the store keeps the old one would
        // point the syncer at a PDS the user has left. Only 'pds' custody
        // owns a repoHost; the store treats a present key as an explicit
        // clear, so 'stratos' custody must not send the key at all.
        ...(pdsEndpointChanged
          ? custody === 'pds'
            ? { pdsEndpoint, repoHost }
            : { pdsEndpoint }
          : {}),
      })
    }
    if (custodyDiverged) {
      logger?.warn(
        { did, storedCustody, wantedCustody, spacesCapability },
        'custody diverged from the granted scope, migration required',
      )
    }
  }
}

/** Result of provisioning a new enrollment's signing key, independent of custody class. */
interface SigningKeyProvision {
  userSigningKeyDid: string
  repoHost: string | undefined
}

/**
 * Provision 'stratos' custody: initialize the Stratos-hosted repo and
 * generate a Stratos-managed signing key for it. This is today's unchanged
 * enrollment path.
 */
async function provisionStratosSigningKey(
  did: string,
  initRepo: OAuthRoutesConfig['initRepo'],
  createSigningKey: OAuthRoutesConfig['createSigningKey'],
): Promise<SigningKeyProvision> {
  await initRepo(did)
  const userSigningKeyDid = await createSigningKey(did)
  return { userSigningKeyDid, repoHost: undefined }
}

/**
 * Provision 'pds' custody: no Stratos repo is created. The user's own
 * spaces-capable PDS hosts the repo, signed with their own `#atproto` key
 * read from their DID document. Fails closed (throws) if that key is absent
 * -- callers must not fall back to Stratos custody on failure.
 */
async function provisionPdsSigningKey(
  did: string,
  idResolver: IdResolver,
): Promise<SigningKeyProvision> {
  // Take the key and the host from one document. The enrolment result has no
  // PDS endpoint in open mode, where eligibility returns before the document
  // is resolved.
  const identity = await resolveAtprotoIdentity(did, idResolver)
  return {
    userSigningKeyDid: identity.signingKeyDid,
    repoHost: identity.pdsEndpoint,
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
  idResolver: IdResolver
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
    idResolver,
    enrollBoundaries,
    pdsEndpoint,
    spacesCapability,
    logger,
  } = deps

  const custody = classifyCustody(spacesCapability)
  if (!custody) {
    logger?.warn(
      { did, spacesCapability },
      'cannot enroll when PDS spaces capability is unknown',
    )
    throw new Error('Could not determine PDS spaces capability')
  }
  const { userSigningKeyDid, repoHost } =
    custody === 'pds'
      ? await provisionPdsSigningKey(did, idResolver)
      : await provisionStratosSigningKey(did, initRepo, createSigningKey)

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
    custody,
    repoHost,
  })

  // Create enrollment record
  await enrollmentStore.enroll({
    did,
    enrolledAt: new Date().toISOString(),
    pdsEndpoint,
    boundaries: enrollBoundaries,
    signingKeyDid: userSigningKeyDid,
    active: true,
    enrollmentRkey,
    custody,
    repoHost,
    capabilityVerdict: spacesCapability,
  })

  logger?.info(
    { did, spacesCapability, custody },
    'determined enrollment custody',
  )
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
