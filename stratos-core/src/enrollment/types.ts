// Re-export EnrollmentConfig from shared types
export type { EnrollmentConfig } from '../types.js'

/**
 * Enrollment data for a user
 */
export interface Enrollment {
  did: string
  boundaries: string[]
  enrolledAt: Date
  pdsEndpoint: string
  signingKeyDid: string
  active: boolean
  enrollmentRkey?: string
  isService?: boolean
}

/**
 * Whether a user's PDS supports spaces, decided at enrolment from the
 * granted OAuth scope (not probed). `unknown` means the check itself failed
 * and must never be treated as `not-capable`.
 */
export type SpacesCapability = 'capable' | 'not-capable' | 'unknown'

/**
 * Who hosts and signs a user's repo. 'stratos' is the Stratos-hosted,
 * Stratos-signed repo (the only mode available today). 'pds' is the user's
 * own spaces-capable PDS, signing with their own `#atproto` key.
 */
export type Custody = 'stratos' | 'pds'

/**
 * Result of enrollment validation
 */
export interface EnrollmentValidationResult {
  allowed: boolean
  reason?: import('../shared/errors.js').EnrollmentDenialReason
  pdsEndpoint?: string
  autoEnrollDomains?: string[]
}
