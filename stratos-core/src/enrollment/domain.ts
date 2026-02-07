import type { EnrollmentConfig } from '../types.js'
import type { EnrollmentValidationResult } from './types.js'

/**
 * Extract PDS endpoint from a DID document
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
 */
export function isDidAllowed(config: EnrollmentConfig, did: string): boolean {
  if (config.mode === 'open') {
    return true
  }
  return config.allowedDids?.includes(did) ?? false
}

/**
 * Check if a PDS endpoint is in the allowlist
 */
export function isPdsAllowed(
  config: EnrollmentConfig,
  pdsEndpoint: string,
): boolean {
  if (config.mode === 'open') {
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
    if (pdsEndpoint) {
      return { allowed: true, pdsEndpoint }
    }
    return { allowed: true }
  }

  // DID not in allowlist - check PDS endpoint allowlist
  if (pdsEndpoint && isPdsAllowed(config, pdsEndpoint)) {
    return { allowed: true, pdsEndpoint }
  }

  return { allowed: false, reason: 'NotInAllowlist' }
}
