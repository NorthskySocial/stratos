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
 * Error thrown when a CID or URI is invalid
 */
export class InvalidIdentifierError extends StratosError {
  constructor(message: string) {
    super(message, 'InvalidIdentifier')
    this.name = 'InvalidIdentifierError'
  }
}

/**
 * Error thrown when MST operations fail
 */
export class MstError extends StratosError {
  constructor(message: string) {
    super(message, 'MstError')
    this.name = 'MstError'
  }
}
