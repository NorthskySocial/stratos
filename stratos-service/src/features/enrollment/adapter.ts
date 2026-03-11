import type { IdResolver, DidDocument } from '@atproto/identity'
import type {
  EnrollmentService,
  EnrollmentValidator,
  ProfileRecordWriter,
  BoundaryResolver,
  Enrollment,
  EnrollmentConfig,
  EnrollmentValidationResult,
  EnrollmentStoreReader,
  Logger,
} from '@northskysocial/stratos-core'
import {
  extractPdsEndpoint,
  validateEnrollmentEligibility,
  NotEnrolledError,
} from '@northskysocial/stratos-core'
import type { EnrollmentStore } from '../../oauth/routes.js'

/**
 * Implementation of EnrollmentService port
 */
export class EnrollmentServiceImpl implements EnrollmentService {
  constructor(
    private enrollmentStore: EnrollmentStore,
    private actorStoreCreator: (did: string) => Promise<void>,
    private logger?: Logger,
  ) {}

  async enroll(
    did: string,
    boundaries: string[],
    signingKeyDid: string,
  ): Promise<Enrollment> {
    const start = Date.now()
    const now = new Date()

    await this.actorStoreCreator(did)

    await this.enrollmentStore.enroll({
      did,
      enrolledAt: now.toISOString(),
      pdsEndpoint: undefined,
      signingKeyDid,
      active: true,
    })

    this.logger?.info(
      { did, boundaryCount: boundaries.length, durationMs: Date.now() - start },
      'user enrolled',
    )

    return {
      did,
      boundaries,
      enrolledAt: now,
      pdsEndpoint: '',
      signingKeyDid,
      active: true,
    }
  }

  async isEnrolled(did: string): Promise<boolean> {
    return this.enrollmentStore.isEnrolled(did)
  }

  async getEnrollment(did: string): Promise<Enrollment | null> {
    const record = await this.enrollmentStore.getEnrollment(did)
    if (!record) return null

    return {
      did: record.did,
      boundaries: [],
      enrolledAt: new Date(record.enrolledAt),
      pdsEndpoint: record.pdsEndpoint ?? '',
      signingKeyDid: record.signingKeyDid,
      active: record.active,
    }
  }

  async unenroll(did: string): Promise<void> {
    await this.enrollmentStore.unenroll(did)
    this.logger?.info({ did }, 'user unenrolled')
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
 * Implementation of ProfileRecordWriter port
 * Writes enrollment record to user's PDS via their OAuth session
 */
export class ProfileRecordWriterImpl implements ProfileRecordWriter {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private getAgent: (did: string) => Promise<{ api: any } | null>,
  ) {}

  async writeEnrollmentRecord(
    did: string,
    serviceEndpoint: string,
    boundaries: string[],
  ): Promise<void> {
    const agent = await this.getAgent(did)
    if (!agent) {
      throw new NotEnrolledError(did)
    }

    await agent.api.com.atproto.repo.putRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey: 'self',
      record: {
        service: serviceEndpoint,
        boundaries: boundaries.map((value) => ({ value })),
        createdAt: new Date().toISOString(),
      },
    })
  }

  async deleteEnrollmentRecord(did: string): Promise<void> {
    const agent = await this.getAgent(did)
    if (!agent) {
      throw new NotEnrolledError(did)
    }

    await agent.api.com.atproto.repo.deleteRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey: 'self',
    })
  }
}

/**
 * Implementation of BoundaryResolver port
 * Resolves boundaries from storage (per-user boundaries)
 */
export class EnrollmentBoundaryResolver implements BoundaryResolver {
  constructor(private enrollmentStore: EnrollmentStoreReader) {}

  async getBoundaries(did: string): Promise<string[]> {
    return this.enrollmentStore.getBoundaries(did)
  }
}
