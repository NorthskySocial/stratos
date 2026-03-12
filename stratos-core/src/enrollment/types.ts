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
}

/**
 * Result of enrollment validation
 */
export interface EnrollmentValidationResult {
  allowed: boolean
  reason?: import('../shared/errors.js').EnrollmentDenialReason
  pdsEndpoint?: string
}
