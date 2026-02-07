import { eq } from 'drizzle-orm'
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
} from '@anthropic/stratos-core'
import {
  extractPdsEndpoint,
  validateEnrollmentEligibility,
  NotEnrolledError,
  EnrollmentDeniedError,
} from '@anthropic/stratos-core'
import type { ServiceDb } from '../../db/index.js'
import { enrollment } from '../../db/index.js'

/**
 * Enrollment store for persistence
 */
export interface EnrollmentStore {
  db: ServiceDb
}

/**
 * Implementation of EnrollmentService port
 */
export class EnrollmentServiceImpl implements EnrollmentService {
  constructor(
    private store: EnrollmentStore,
    private actorStoreCreator: (did: string) => Promise<void>,
    private logger?: Logger,
  ) {}

  async enroll(did: string, boundaries: string[]): Promise<Enrollment> {
    const start = Date.now()
    const now = new Date()
    
    await this.actorStoreCreator(did)

    await this.store.db.insert(enrollment).values({
      did,
      enrolledAt: now.toISOString(),
      pdsEndpoint: null, // Will be updated by the validator
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
    }
  }

  async isEnrolled(did: string): Promise<boolean> {
    const result = await this.store.db
      .select({ did: enrollment.did })
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)
    
    return result.length > 0
  }

  async getEnrollment(did: string): Promise<Enrollment | null> {
    const result = await this.store.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)
    
    if (result.length === 0) {
      return null
    }

    const record = result[0]
    return {
      did: record.did,
      boundaries: [], // TODO: fetch from actor store
      enrolledAt: new Date(record.enrolledAt),
      pdsEndpoint: record.pdsEndpoint ?? '',
    }
  }

  async unenroll(did: string): Promise<void> {
    await this.store.db
      .delete(enrollment)
      .where(eq(enrollment.did, did))

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
      collection: 'app.stratos.actor.enrollment',
      rkey: 'self',
      record: {
        service: serviceEndpoint,
        boundaries: boundaries.map(value => ({ value })),
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
      collection: 'app.stratos.actor.enrollment',
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
