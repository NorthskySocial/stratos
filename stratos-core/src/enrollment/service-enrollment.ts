import { InvalidServiceEnrollmentError } from '../shared/errors.js'
import { ensureQualifiedBoundaries } from '../validation/boundary-qualification.js'

/**
 * A service enrollment declared via operator configuration.
 *
 * Service enrollments grant a downstream service (e.g. an AppView or indexer)
 * access to a set of boundaries. They are reconciled into the enrollment store
 * on startup and are distinguished from user enrollments by `isService = true`,
 * never by the presence or absence of a PDS endpoint.
 */
export interface ServiceEnrollment {
  /** DID of the service being enrolled. */
  did: string
  /** Qualified boundaries granted to the service. */
  boundaries: string[]
  /**
   * Optional `did:key` public signing key for the service. When present, the
   * Stratos service can verify the service's inter-service JWTs without a
   * network DID resolution (e.g. for non-resolvable `did:web` DIDs in tests or
   * local development).
   */
  signingKey?: string
}

/**
 * Raw service-enrollment entry as parsed from configuration, before validation.
 */
export interface RawServiceEnrollment {
  did?: unknown
  boundaries?: unknown
  signingKey?: unknown
}

/**
 * Options controlling service-enrollment validation.
 */
export interface ValidateServiceEnrollmentsOptions {
  /** Bare service DID used to qualify boundaries (e.g. `did:web:host`). */
  serviceDid: string
  /** The set of boundaries the service is allowed to grant. */
  allowedDomains: string[]
}

/**
 * Validate and normalise raw service-enrollment config entries.
 *
 * Each entry's `did` must be a non-empty string and unique across the set.
 * Boundaries are qualified against `serviceDid` (bare names auto-qualified),
 * must be non-empty, and must all be members of `allowedDomains`. Invalid input
 * fails fast with {@link InvalidServiceEnrollmentError}.
 *
 * @param entries - Raw entries parsed from configuration.
 * @param options - Service DID and allowed domains used for validation.
 * @returns The validated, boundary-qualified service enrollments.
 */
export function validateServiceEnrollments(
  entries: RawServiceEnrollment[],
  options: ValidateServiceEnrollmentsOptions,
): ServiceEnrollment[] {
  const { serviceDid, allowedDomains } = options
  const allowed = new Set(allowedDomains)
  const seen = new Set<string>()
  const result: ServiceEnrollment[] = []

  for (const entry of entries) {
    const did = entry.did
    if (typeof did !== 'string' || did.length === 0) {
      throw new InvalidServiceEnrollmentError(
        'service enrollment entry is missing a non-empty "did"',
      )
    }

    if (seen.has(did)) {
      throw new InvalidServiceEnrollmentError(
        `duplicate service enrollment for did "${did}"`,
      )
    }
    seen.add(did)

    const rawBoundaries = entry.boundaries
    if (!Array.isArray(rawBoundaries)) {
      throw new InvalidServiceEnrollmentError(
        `service enrollment "${did}" must declare a "boundaries" array`,
      )
    }

    for (const boundary of rawBoundaries) {
      if (typeof boundary !== 'string' || boundary.length === 0) {
        throw new InvalidServiceEnrollmentError(
          `service enrollment "${did}" has an invalid boundary`,
        )
      }
    }

    if (rawBoundaries.length === 0) {
      throw new InvalidServiceEnrollmentError(
        `service enrollment "${did}" must declare at least one boundary`,
      )
    }

    const qualified = ensureQualifiedBoundaries(
      serviceDid,
      rawBoundaries as string[],
    )

    for (const boundary of qualified) {
      if (!allowed.has(boundary)) {
        throw new InvalidServiceEnrollmentError(
          `service enrollment "${did}" references boundary "${boundary}" not in allowedDomains`,
        )
      }
    }

    const signingKey = validateSigningKey(did, entry.signingKey)

    result.push(
      signingKey
        ? { did, boundaries: qualified, signingKey }
        : { did, boundaries: qualified },
    )
  }

  return result
}

/**
 * Validate an optional `signingKey` field on a service-enrollment entry.
 *
 * When provided it must be a non-empty `did:key` string. Returns the validated
 * key, or `undefined` when the field is absent.
 */
function validateSigningKey(did: string, value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || !value.startsWith('did:key:')) {
    throw new InvalidServiceEnrollmentError(
      `service enrollment "${did}" has an invalid "signingKey" (must be a did:key)`,
    )
  }
  return value
}
