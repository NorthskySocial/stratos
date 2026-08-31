/**
 * Base error class for Stratos domain errors
 */
export class StratosError extends Error {
  constructor(
    message: string,
    public code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StratosError'
  }
}

/**
 * Error thrown when a user is not enrolled in the Stratos service
 */
export class NotEnrolledError extends StratosError {
  constructor(did: string, options?: { cause?: unknown }) {
    super(`User ${did} is not enrolled`, 'NotEnrolled', options)
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
    options?: { cause?: unknown },
  ) {
    super(message, 'EnrollmentDenied', options)
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
  | 'VerificationFailed'

/**
 * Error thrown when a boundary is not allowed
 */
export class BoundaryNotAllowedError extends StratosError {
  constructor(boundary: string, options?: { cause?: unknown }) {
    super(`Boundary '${boundary}' not allowed`, 'ForbiddenBoundary', options)
    this.name = 'BoundaryNotAllowedError'
  }
}

/**
 * Error thrown when a configured service enrollment is invalid
 */
export class InvalidServiceEnrollmentError extends StratosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'InvalidServiceEnrollment', options)
    this.name = 'InvalidServiceEnrollmentError'
  }
}

/**
 * Error thrown when a record is not found
 */
export class RecordNotFoundError extends StratosError {
  constructor(uri: string, options?: { cause?: unknown }) {
    super(`Record not found: ${uri}`, 'RecordNotFound', options)
    this.name = 'RecordNotFoundError'
  }
}

/**
 * Error thrown when a CID or URI is invalid
 */
export class InvalidIdentifierError extends StratosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'InvalidIdentifier', options)
    this.name = 'InvalidIdentifierError'
  }
}

/**
 * Error thrown when MST operations fail
 */
export class MstError extends StratosError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'MstError', options)
    this.name = 'MstError'
  }
}

/**
 * Error thrown when a blob access is denied
 */
export class BlobAccessDeniedError extends StratosError {
  constructor(cid: string, options?: { cause?: unknown }) {
    super(`Access denied to blob: ${cid}`, 'BlobAccessDenied', options)
    this.name = 'BlobAccessDeniedError'
  }
}

/**
 * Error thrown when a PDS-custody enrollment's DID document has no usable
 * `#atproto` signing key. Enrollment must fail closed rather than fall back
 * to Stratos custody or store an empty signing key.
 */
export class MissingAtprotoKeyError extends StratosError {
  constructor(did: string, options?: { cause?: unknown }) {
    super(
      `No usable #atproto key found for ${did}`,
      'MissingAtprotoKey',
      options,
    )
    this.name = 'MissingAtprotoKeyError'
  }
}

export class PdsCustodyWriteForbiddenError extends StratosError {
  constructor(options?: { cause?: unknown }) {
    super(
      'This actor writes records to their own PDS',
      'PdsCustodyWriteForbidden',
      options,
    )
    this.name = 'PdsCustodyWriteForbiddenError'
  }
}
