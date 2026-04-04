import { StratosConfig, StratosValidationError } from '../types.js'

export type RepoRecord = Record<string, unknown>

/**
 * Interface for validating records against a specific collection.
 */
export interface RecordValidator {
  /**
   * The collection this validator validates.
   */
  collection: string

  /**
   * Validate a record.
   * @param record - The record to validate.
   * @param parentBoundaries - The boundaries of the parent record, if this is a reply.
   * @throws StratosValidationError if the record is invalid.
   */
  validate(record: RepoRecord, parentBoundaries?: string[]): void
}

/**
 * Base class for record validators.
 * This class provides common validation logic for all record validators.
 */
export abstract class BaseValidator implements RecordValidator {
  abstract collection: string

  constructor(protected config: StratosConfig) {}

  /**
   * Validate a record.
   * @param record - The record to validate.
   * @param parentBoundaries - The boundaries of the parent record, if this is a reply.
   * @throws StratosValidationError if the record is invalid.
   */
  abstract validate(record: RepoRecord, parentBoundaries?: string[]): void

  /**
   * Asserts that a record has a boundary with at least one domain.
   * @param boundary - The boundary to validate.
   * @throws StratosValidationError if the boundary is missing or empty.
   */
  protected assertBoundaryPresence(boundary: unknown): void {
    if (!boundary || typeof boundary !== 'object') {
      throw new StratosValidationError(
        'Record must have a boundary',
        'MissingBoundary',
      )
    }

    const b = boundary as { values?: unknown[] }
    if (!Array.isArray(b.values) || b.values.length === 0) {
      throw new StratosValidationError(
        'Record must have a boundary',
        'MissingBoundary',
      )
    }
  }

  /**
   * Validate the domains in a boundary.
   * @param boundary - The boundary to validate.
   * @throws StratosValidationError if a domain is not allowed or does not belong to the service.
   */
  protected validateBoundaryDomains(boundary: unknown): void {
    const b = boundary as { values: Array<{ value: string }> }
    for (const d of b.values) {
      let domain = d.value
      if (domain.startsWith('did:')) {
        if (!domain.startsWith(`${this.config.serviceDid}/`)) {
          throw new StratosValidationError(
            `Boundary '${domain}' does not belong to this service`,
            'ForbiddenDomain',
          )
        }
        domain = domain.split('/')[1]
      }

      if (!this.config.allowedDomains.includes(domain)) {
        throw new StratosValidationError(
          `Domain '${domain}' is not allowed for this service`,
          'ForbiddenDomain',
        )
      }
    }
  }
}
