import type { Enrollment, EnrollmentValidationResult } from './types.js'

/**
 * Port interface for enrollment service.
 * Adapters implement this interface to provide enrollment functionality.
 */
export interface EnrollmentService {
  /**
   * Enroll a user in the Stratos service
   * @param did - User's DID
   * @param boundaries - Boundaries the user should have access to
   * @returns The created enrollment
   */
  enroll(
    did: string,
    boundaries: string[],
    signingKeyDid: string,
  ): Promise<Enrollment>

  /**
   * Check if a user is enrolled
   * @param did - User's DID
   * @returns True if the user is enrolled
   */
  isEnrolled(did: string): Promise<boolean>

  /**
   * Get enrollment data for a user
   * @param did - User's DID
   * @returns Enrollment data or null if not enrolled
   */
  getEnrollment(did: string): Promise<Enrollment | null>

  /**
   * Remove a user's enrollment
   * @param did - User's DID
   */
  unenroll(did: string): Promise<void>
}

/**
 * Port interface for enrollment validation.
 * Validates whether a user is allowed to enroll based on configuration.
 */
export interface EnrollmentValidator {
  /**
   * Validate if a user is allowed to enroll
   * @param did - User's DID
   * @returns Validation result with allowed status and reason
   */
  validate(did: string): Promise<EnrollmentValidationResult>
}

/**
 * Port interface for profile record writer.
 * Writes the enrollment profile record to the user's PDS.
 */
export interface ProfileRecordWriter {
  /**
   * Write the enrollment profile record to the user's PDS
   * @param did - User's DID
   * @param serviceEndpoint - This Stratos service's endpoint URL
   * @param boundaries - Boundaries the user has access to
   */
  writeEnrollmentRecord(
    did: string,
    serviceEndpoint: string,
    boundaries: string[],
  ): Promise<void>

  /**
   * Delete the enrollment profile record from the user's PDS
   * @param did - User's DID
   */
  deleteEnrollmentRecord(did: string): Promise<void>
}

/**
 * Port interface for resolving user boundaries.
 * Used to determine what domains a user has access to for record filtering.
 */
export interface BoundaryResolver {
  /**
   * Get the boundaries (domains) that a user has access to
   * @param did - User's DID
   * @returns Array of domain strings the user has access to
   */
  getBoundaries(did: string): Promise<string[]>
}
