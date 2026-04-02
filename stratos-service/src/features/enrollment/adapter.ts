import type { DidDocument, IdResolver } from '@atproto/identity'
import type {
  BoundaryResolver,
  Enrollment,
  EnrollmentConfig,
  EnrollmentService,
  EnrollmentStoreReader,
  EnrollmentValidationResult,
  EnrollmentValidator,
  Logger,
} from '@northskysocial/stratos-core'
import {
  ensureQualifiedBoundaries,
  extractPdsEndpoint,
  isQualifiedBoundary,
  validateEnrollmentEligibility,
} from '@northskysocial/stratos-core'
import type { EnrollmentStore } from '../../oauth/routes.js'
import type { EnrollmentEventEmitter } from '../../context-types.js'

export interface MigrationDeps {
  enrollmentStore: {
    getBoundaries(did: string): Promise<string[]>
    setBoundaries(did: string, boundaries: string[]): Promise<void>
  }
  serviceDid: string
  logger?: Logger
}

/**
 * Implementation of EnrollmentService port
 */
export class EnrollmentServiceImpl implements EnrollmentService {
  constructor(
    private enrollmentStore: EnrollmentStore,
    private actorStoreCreator: (did: string) => Promise<void>,
    private actorStoreDestroyer: (did: string) => Promise<void>,
    private logger?: Logger,
    private enrollmentEvents?: EnrollmentEventEmitter,
    private serviceUrl?: string,
  ) {}

  /**
   * Enroll a user with the given DID, boundaries, and signing key DID.
   *
   * @param did - The user's DID.
   * @param boundaries - The boundaries to enroll the user with.
   * @param signingKeyDid - The DID of the signing key.
   * @returns A promise that resolves to the enrollment object.
   */
  async enroll(
    did: string,
    boundaries: string[],
    signingKeyDid: string,
  ): Promise<Enrollment> {
    const now = new Date()

    await this.actorStoreCreator(did)
    await this.saveEnrollment(did, signingKeyDid, now)

    this.emitEnrollmentEvent(did, boundaries, now)
    return this.createEnrollmentObject(did, boundaries, signingKeyDid, now)
  }

  /**
   * Check if a user is enrolled with the given DID.
   *
   * @param did - The user's DID.
   * @returns A promise that resolves to a boolean indicating if the user is enrolled.
   */
  async isEnrolled(did: string): Promise<boolean> {
    return this.enrollmentStore.isEnrolled(did)
  }

  /**
   * Get the enrollment record for a user with the given DID.
   *
   * @param did - The user's DID.
   * @returns A promise that resolves to the enrollment record or null if not found.
   */
  async getEnrollment(did: string): Promise<Enrollment | null> {
    const record = await this.enrollmentStore.getEnrollment(did)
    if (!record) return null

    const boundaries = await this.enrollmentStore.getBoundaries(did)

    return {
      did: record.did,
      boundaries,
      enrolledAt: new Date(record.enrolledAt),
      pdsEndpoint: record.pdsEndpoint ?? '',
      signingKeyDid: record.signingKeyDid,
      active: record.active,
      enrollmentRkey: record.enrollmentRkey,
    }
  }

  /**
   * Unenroll a user with the given DID.
   *
   * @param did - The user's DID.
   */
  async unenroll(did: string): Promise<void> {
    await this.enrollmentStore.unenroll(did)
    await this.actorStoreDestroyer(did)
    this.logger?.info({ did }, 'user unenrolled (hard delete)')

    this.enrollmentEvents?.emit('enrollment', {
      did,
      action: 'unenroll',
      time: new Date().toISOString(),
    })
  }

  /**
   * Save enrollment record for a user.
   *
   * @param did - The user's DID.
   * @param signingKeyDid - The DID of the signing key.
   * @param now - The current date and time.
   * @private
   */
  private async saveEnrollment(did: string, signingKeyDid: string, now: Date) {
    await this.enrollmentStore.enroll({
      did,
      enrolledAt: now.toISOString(),
      pdsEndpoint: undefined,
      signingKeyDid,
      active: true,
    })
  }

  private emitEnrollmentEvent(did: string, boundaries: string[], now: Date) {
    this.logger?.info(
      { did, boundaryCount: boundaries.length },
      'user enrolled',
    )

    this.enrollmentEvents?.emit('enrollment', {
      did,
      action: 'enroll',
      service: this.serviceUrl,
      boundaries,
      time: now.toISOString(),
    })
  }

  /**
   * Create an enrollment object for a user.
   *
   * @param did - The user's DID.
   * @param boundaries - The boundaries for the user's enrollment.
   * @param signingKeyDid - The DID of the signing key.
   * @param now - The current date and time.
   * @private
   */
  private createEnrollmentObject(
    did: string,
    boundaries: string[],
    signingKeyDid: string,
    now: Date,
  ): Enrollment {
    return {
      did,
      boundaries,
      enrolledAt: now,
      pdsEndpoint: '',
      signingKeyDid,
      active: true,
    }
  }
}

/**
 * Implementation of EnrollmentValidator port
 */
export class EnrollmentValidatorImpl implements EnrollmentValidator {
  constructor(
    private config: EnrollmentConfig,
    private idResolver: IdResolver,
  ) {}

  /**
   * Validate a DID against the enrollment allowlist.
   *
   * @param did - The user's DID.
   * @returns The enrollment validation result.
   */
  async validate(did: string): Promise<EnrollmentValidationResult> {
    let didDoc: DidDocument | null
    try {
      didDoc = await this.idResolver.did.resolve(did)
    } catch {
      return { allowed: false, reason: 'DidNotResolved' }
    }

    if (!didDoc) {
      return { allowed: false, reason: 'DidNotResolved' }
    }

    const pdsEndpoint = extractPdsEndpoint(didDoc)
    return validateEnrollmentEligibility(this.config, did, pdsEndpoint)
  }
}

/**
 * Implementation of BoundaryResolver port
 * Resolves boundaries from storage (per-user boundaries)
 */
export class EnrollmentBoundaryResolver implements BoundaryResolver {
  constructor(private enrollmentStore: EnrollmentStoreReader) {}

  /**
   * Get the boundaries for a user with the given DID.
   * @param did - The user's DID.
   * @returns A promise that resolves to an array of boundaries.
   '
   */
  async getBoundaries(did: string): Promise<string[]> {
    return this.enrollmentStore.getBoundaries(did)
  }
}

/**
 * Wraps a BoundaryResolver with lazy migration (read-repair).
 * When legacy bare-name boundaries are returned, qualifies them in-place,
 * updates the DB, and fires a callback for PDS re-enrollment.
 */
export class MigratingBoundaryResolver implements BoundaryResolver {
  onMigrated?: (did: string, boundaries: string[]) => void

  constructor(private deps: MigrationDeps) {}

  /**
   * Get boundaries for a user, migrating if necessary.
   *
   * @param did - The user's DID.
   * @returns The user's boundaries, possibly migrated.
   */
  async getBoundaries(did: string): Promise<string[]> {
    const boundaries = await this.deps.enrollmentStore.getBoundaries(did)
    if (boundaries.length === 0) return boundaries

    return await this.migrateIfNeeded(did, boundaries)
  }

  /**
   * Migrate boundaries for a user if necessary.
   *
   * @param did - The user's DID.
   * @param boundaries - The user's current boundaries.
   * @returns The user's boundaries, possibly migrated.
   * @private
   */
  private async migrateIfNeeded(
    did: string,
    boundaries: string[],
  ): Promise<string[]> {
    const hasLegacy = boundaries.some((b) => !isQualifiedBoundary(b))
    if (!hasLegacy) return boundaries

    const qualified = ensureQualifiedBoundaries(
      this.deps.serviceDid,
      boundaries,
    )

    const success = await this.persistMigrated(
      did,
      qualified,
      boundaries.length,
    )
    if (success) {
      this.onMigrated?.(did, qualified)
    }

    return qualified
  }

  /**
   * Persist migrated boundaries for a user.
   *
   * @param did - The user's DID.
   * @param qualified - The user's boundaries in qualified format.
   * @param oldCount - The number of boundaries before migration.
   * @returns True if the migration was successful, false otherwise.
   * @private
   */
  private async persistMigrated(
    did: string,
    qualified: string[],
    oldCount: number,
  ): Promise<boolean> {
    try {
      await this.deps.enrollmentStore.setBoundaries(did, qualified)
      this.deps.logger?.info(
        { did, count: oldCount },
        'migrated legacy boundaries to qualified format',
      )
      return true
    } catch (err) {
      this.deps.logger?.warn(
        { did, err },
        'failed to persist migrated boundaries',
      )
      return false
    }
  }
}
