/**
 * Base error class for Stratos domain errors
 */
export class StratosError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
    this.name = 'StratosError'
  }
}

/**
 * Error thrown when a user is not enrolled in the Stratos service
 */
export class NotEnrolledError extends StratosError {
  constructor(did: string) {
    super(`User ${did} is not enrolled`, 'NotEnrolled')
    this.name = 'NotEnrolledError'
  }
}

/**
 * Error thrown when enrollment is denied
 */
export class EnrollmentDeniedError extends StratosError {
  constructor(
    message: string,
    public reason: EnrollmentDenialReason,
  ) {
    super(message, 'EnrollmentDenied')
    this.name = 'EnrollmentDeniedError'
  }
}

/**
 * Reasons for enrollment denial
 */
export type EnrollmentDenialReason =
  | 'NotInAllowlist'
  | 'DidNotResolved'
  | 'PdsEndpointNotFound'
  | 'ServiceClosed'

/**
 * Error thrown when a boundary is not allowed
 */
export class BoundaryNotAllowedError extends StratosError {
  constructor(boundary: string) {
    super(`Boundary '${boundary}' not allowed`, 'ForbiddenBoundary')
    this.name = 'BoundaryNotAllowedError'
  }
}

/**
 * Error thrown when a record is not found
 */
export class RecordNotFoundError extends StratosError {
  constructor(uri: string) {
    super(`Record not found: ${uri}`, 'RecordNotFound')
    this.name = 'RecordNotFoundError'
  }
}

/**
 * Error thrown when access to a record is blocked due to boundary restrictions
 */
export class BoundaryBlockedError extends StratosError {
  constructor(uri: string) {
    super(`Access to record blocked by boundary restrictions: ${uri}`, 'BoundaryBlocked')
    this.name = 'BoundaryBlockedError'
  }
}
