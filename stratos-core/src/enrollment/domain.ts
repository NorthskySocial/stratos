import { ENROLLMENT_MODE, EnrollmentConfig } from '../types.js'
import { PdsCustodyWriteForbiddenError } from '../shared/errors.js'
import type {
  Custody,
  EnrollmentValidationResult,
  SpacesCapability,
} from './types.js'

/**
 * Extract PDS endpoint from a DID document
 * @param didDoc - The DID document to extract the PDS endpoint from.
 * @returns The PDS endpoint if found, otherwise null.
 */
export function extractPdsEndpoint(didDoc: {
  service?: unknown[]
}): string | null {
  const services = didDoc.service
  if (!Array.isArray(services)) {
    return null
  }

  for (const service of services) {
    if (typeof service !== 'object' || service === null) continue
    const svc = service as { id?: string; serviceEndpoint?: unknown }

    // Look for ATProto PDS service
    if (svc.id === '#atproto_pds' || svc.id?.endsWith('#atproto_pds')) {
      if (typeof svc.serviceEndpoint === 'string') {
        return svc.serviceEndpoint
      }
    }
  }

  return null
}

/**
 * Check if a DID is in the allowlist
 * @param config - Enrollment configuration
 * @param did - The DID to check
 * @returns True if the DID is allowed, false otherwise
 */
export function isDidAllowed(config: EnrollmentConfig, did: string): boolean {
  if (config.mode === ENROLLMENT_MODE.OPEN) {
    return true
  }
  return config.allowedDids?.includes(did) ?? false
}

/**
 * Check if a PDS endpoint is in the allowlist
 * @param config - Enrollment configuration
 * @param pdsEndpoint - The PDS endpoint to check
 * @returns True if the PDS endpoint is allowed, false otherwise
 */
export function isPdsAllowed(
  config: EnrollmentConfig,
  pdsEndpoint: string,
): boolean {
  if (config.mode === ENROLLMENT_MODE.OPEN) {
    return true
  }

  // Normalize endpoints for comparison
  const normalizedEndpoint = pdsEndpoint.replace(/\/$/, '')
  return (
    config.allowedPdsEndpoints?.some(
      (allowed) => allowed.replace(/\/$/, '') === normalizedEndpoint,
    ) ?? false
  )
}

/**
 * Validate enrollment eligibility based on configuration
 * This is pure domain logic - no I/O
 *
 * @param config - Enrollment configuration
 * @param did - User's DID
 * @param pdsEndpoint - PDS endpoint (null if not resolved)
 * @returns Enrollment validation result
 */
export function validateEnrollmentEligibility(
  config: EnrollmentConfig,
  did: string,
  pdsEndpoint: string | null,
): EnrollmentValidationResult {
  // Check if service is in open mode or DID is explicitly allowed
  if (isDidAllowed(config, did)) {
    // DID is allowed, pdsEndpoint is optional for enrollment permission
    return {
      allowed: true,
      pdsEndpoint: pdsEndpoint ?? undefined,
      autoEnrollDomains: config.autoEnrollDomains,
    }
  }

  // DID not in allowlist - check PDS endpoint allowlist
  if (pdsEndpoint && isPdsAllowed(config, pdsEndpoint)) {
    return {
      allowed: true,
      pdsEndpoint,
      autoEnrollDomains: config.autoEnrollDomains,
    }
  }

  return { allowed: false, reason: 'NotInAllowlist' }
}

/**
 * Decide which repo custody a new enrollment gets from its capability
 * probe verdict. An inconclusive result cannot safely select a custody class.
 *
 * @param spacesCapability - The enrolment-time capability probe verdict.
 * @returns The custody class for the new enrollment, or undefined when the
 * capability probe did not produce a usable result.
 */
export function classifyCustody(
  spacesCapability: SpacesCapability | undefined,
): Custody | undefined {
  if (spacesCapability === 'capable') return 'pds'
  if (spacesCapability === 'not-capable') return 'stratos'
  return undefined
}

/** Reject a Stratos write for an actor whose PDS owns their repository. */
export function assertStratosWriteAllowed(custody: Custody | undefined): void {
  if (custody === 'pds') throw new PdsCustodyWriteForbiddenError()
}

/**
 * Report which custody class a re-authorising enrollment's capability verdict
 * would grant, so the caller can compare it against what is actually stored.
 * It does not decide the stored custody -- moving custody means moving the
 * repo and changing the signing key, and re-auth does neither. Flipping the
 * label alone would publish an enrollment whose `signingKey` contradicts its
 * `custody`. MM-10 is the unscheduled migration that will move anyone this
 * function reports as diverged.
 *
 * An 'unknown' verdict, or no verdict at all, reports the current custody as
 * still wanted -- losing the answer is not the same as learning the answer
 * is no, and a transient introspection failure must not read as divergence.
 *
 * @param current - The enrollment's currently stored custody class.
 * @param verdict - The capability verdict this re-auth observed.
 * @returns The custody class the verdict would grant, for comparison only.
 */
export function reconcileCustody(
  current: Custody,
  verdict: SpacesCapability | undefined,
): Custody {
  if (verdict === 'capable') return 'pds'
  if (verdict === 'not-capable') return 'stratos'
  return current
}
