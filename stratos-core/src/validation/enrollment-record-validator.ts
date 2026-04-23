import { BaseValidator, type RepoRecord } from './base.js'

/**
 * Validates stratos enrollment records for domain boundaries.
 */
export class EnrollmentRecordValidator extends BaseValidator {
  collection = 'zone.stratos.actor.enrollment'

  /**
   * Validate an enrollment record.
   * @param record - The record to validate.
   * @param _parentBoundaries - The boundaries of the parent record, if this is a reply.
   * @throws StratosValidationError if the record is invalid.
   */
  validate(record: RepoRecord, _parentBoundaries?: string[]): void {
    this.assertBoundaryPresence(record.boundary)
    // For enrollment records, the boundaries in the record must match the allowed domains of the service
    // or be qualified for this service.
    this.validateBoundaryDomains(record.boundary)
  }
}
