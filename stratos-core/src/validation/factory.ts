import { RecordValidator } from './base.js'
import { StratosConfig } from '../types.js'
import { PostValidator } from './post-validator.js'
import { EnrollmentRecordValidator } from './enrollment-record-validator.js'

/**
 * Factory class for creating validators based on collection.
 */
export class ValidatorFactory {
  private validators: Map<string, RecordValidator>

  constructor(config: StratosConfig) {
    this.validators = new Map()
    const postValidator = new PostValidator(config)
    this.validators.set(postValidator.collection, postValidator)

    const enrollmentValidator = new EnrollmentRecordValidator(config)
    this.validators.set(enrollmentValidator.collection, enrollmentValidator)
  }

  /**
   * Register a new validator for a collection.
   * @param validator - The validator instance to register.
   */
  register(validator: RecordValidator): void {
    this.validators.set(validator.collection, validator)
  }

  /**
   * Get a validator for a collection.
   * @param collection - The collection to get the validator for.
   * @returns The validator instance, or undefined if not found.
   */
  getValidator(collection: string): RecordValidator | undefined {
    return this.validators.get(collection)
  }
}
