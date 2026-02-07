import { IdResolver } from '@atproto/identity'
import {
  type EnrollmentConfig,
  type EnrollmentDenialReason,
  EnrollmentDeniedError,
  extractPdsEndpoint,
  validateEnrollmentEligibility,
  isDidAllowed,
} from '@northskysocial/stratos-core'

// Re-export for convenience
export { type EnrollmentConfig, type EnrollmentDenialReason, EnrollmentDeniedError, extractPdsEndpoint }

/**
 * Result of enrollment validation
 */
export interface EnrollmentResult {
  allowed: boolean
  reason?: EnrollmentDenialReason
  pdsEndpoint?: string
}

/**
 * Validate if a user is allowed to enroll in this Stratos service
 *
 * @param config - Enrollment configuration
 * @param did - User's DID
 * @param idResolver - Identity resolver for DID resolution
 * @returns Enrollment result with allowed status and reason
 */
export async function validateEnrollment(
  config: EnrollmentConfig,
  did: string,
  idResolver: IdResolver,
): Promise<EnrollmentResult> {
  // First check if DID is explicitly allowed (open mode or DID allowlist)
  // This doesn't require DID resolution - return immediately
  if (isDidAllowed(config, did)) {
    // DID is allowed without needing PDS resolution
    return { allowed: true }
  }

  // DID is not in DID allowlist
  // Check if there are any PDS endpoints configured to check
  if (!config.allowedPdsEndpoints?.length) {
    // No PDS endpoints to check, and DID isn't allowed
    return { allowed: false, reason: 'NotInAllowlist' }
  }

  // Need to check PDS endpoint allowlist - this requires resolving the DID
  let didDoc
  try {
    didDoc = await idResolver.did.resolve(did)
  } catch {
    // DID resolution failed
    return { allowed: false, reason: 'DidNotResolved' }
  }

  if (!didDoc) {
    return { allowed: false, reason: 'DidNotResolved' }
  }

  const pdsEndpoint = extractPdsEndpoint(didDoc)
  if (!pdsEndpoint) {
    return { allowed: false, reason: 'PdsEndpointNotFound' }
  }

  // Use the pure domain function for PDS allowlist validation
  const result = validateEnrollmentEligibility(config, did, pdsEndpoint)
  return result
}

/**
 * Assert that enrollment is allowed, throwing if not
 */
export async function assertEnrollment(
  config: EnrollmentConfig,
  did: string,
  idResolver: IdResolver,
): Promise<{ pdsEndpoint?: string }> {
  const result = await validateEnrollment(config, did, idResolver)

  if (!result.allowed) {
    const messages: Record<EnrollmentDenialReason, string> = {
      NotInAllowlist:
        'Your DID is not in the enrollment allowlist for this Stratos service',
      DidNotResolved: 'Could not resolve your DID document',
      PdsEndpointNotFound: 'Could not find a PDS endpoint in your DID document',
      ServiceClosed: 'This Stratos service is not accepting new enrollments',
    }

    throw new EnrollmentDeniedError(
      messages[result.reason!],
      result.reason!,
    )
  }

  return { pdsEndpoint: result.pdsEndpoint }
}
