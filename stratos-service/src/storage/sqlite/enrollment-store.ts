import { asc, eq, gt, and } from 'drizzle-orm'
import {
  type Custody,
  type EnrollmentStoreReader,
  type ListEnrollmentsOptions,
  type SpacesCapability,
  type StoredEnrollment,
} from '@northskysocial/stratos-core'
import {
  enrollment,
  type Enrollment,
  enrollmentBoundary,
  type ServiceDb,
} from '../../db'
import { type EnrollmentRecord, type EnrollmentStore } from '../../oauth'

/**
 * Map a stored enrollment row to the storage-port shape. Rows written before
 * MM-03 have no custody value, so an absent column defaults to 'stratos'.
 */
function toStoredEnrollment(row: Enrollment): StoredEnrollment {
  return {
    did: row.did,
    enrolledAt: row.enrolledAt,
    pdsEndpoint: row.pdsEndpoint ?? undefined,
    signingKeyDid: row.signingKeyDid,
    active: row.active === 'true',
    enrollmentRkey: row.enrollmentRkey ?? undefined,
    isService: row.isService,
    custody: (row.custody as Custody | null) ?? 'stratos',
    repoHost: row.repoHost ?? undefined,
    capabilityVerdict:
      (row.capabilityVerdict as SpacesCapability | null) ?? undefined,
  }
}

/**
 * SQLite enrollment store implements both OAuth EnrollmentStore
 * and stratos-core EnrollmentStoreReader interfaces
 */
export class SqliteEnrollmentStore
  implements EnrollmentStore, EnrollmentStoreReader
{
  constructor(private db: ServiceDb) {}

  /**
   * Check if a DID is enrolled in the service
   * @param did - Decentralized Identifier to check
   * @returns True if enrolled, false otherwise
   */
  async isEnrolled(did: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    return rows.length > 0 && rows[0].active === 'true'
  }

  /**
   * Enroll a DID in the service
   * @param record - Enrollment record to store
   */
  async enroll(record: EnrollmentRecord): Promise<void> {
    await this.db
      .insert(enrollment)
      .values({
        did: record.did,
        enrolledAt: record.enrolledAt,
        pdsEndpoint: record.pdsEndpoint ?? null,
        signingKeyDid: record.signingKeyDid,
        active: record.active ? 'true' : 'false',
        enrollmentRkey: record.enrollmentRkey ?? null,
        isService: record.isService ?? false,
        custody: record.custody ?? 'stratos',
        repoHost: record.repoHost ?? null,
        capabilityVerdict: record.capabilityVerdict ?? null,
      })
      .onConflictDoUpdate({
        target: enrollment.did,
        set: {
          enrolledAt: record.enrolledAt,
          pdsEndpoint: record.pdsEndpoint ?? null,
          signingKeyDid: record.signingKeyDid,
          active: record.active ? 'true' : 'false',
          enrollmentRkey: record.enrollmentRkey ?? null,
          isService: record.isService ?? false,
          custody: record.custody ?? 'stratos',
          repoHost: record.repoHost ?? null,
          capabilityVerdict: record.capabilityVerdict ?? null,
        },
      })

    if (record.boundaries && record.boundaries.length > 0) {
      await this.db
        .delete(enrollmentBoundary)
        .where(eq(enrollmentBoundary.did, record.did))

      await this.db
        .insert(enrollmentBoundary)
        .values(
          record.boundaries.map((boundary) => ({ did: record.did, boundary })),
        )
    }
  }

  /**
   * Unenroll a DID from the service
   * @param did - Decentralized Identifier to unenroll
   */
  async unenroll(did: string): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    await this.db.delete(enrollment).where(eq(enrollment.did, did))
  }

  /**
   * Get enrollment details for a DID
   * @param did - Decentralized Identifier to retrieve enrollment for
   * @returns Enrollment details or null if not found
   */
  async getEnrollment(did: string): Promise<StoredEnrollment | null> {
    const rows = await this.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return toStoredEnrollment(row)
  }

  /**
   * Update enrollment details for a DID
   * @param did - Decentralized Identifier to update enrollment for
   * @param updates - Partial enrollment details to update
   */
  async updateEnrollment(
    did: string,
    updates: Partial<StoredEnrollment>,
  ): Promise<void> {
    const set: Partial<Enrollment> = {}
    if (updates.enrolledAt !== undefined) set.enrolledAt = updates.enrolledAt
    if (updates.pdsEndpoint !== undefined)
      set.pdsEndpoint = updates.pdsEndpoint ?? null
    if (updates.signingKeyDid !== undefined)
      set.signingKeyDid = updates.signingKeyDid
    if (updates.active !== undefined)
      set.active = updates.active ? 'true' : 'false'
    if (updates.enrollmentRkey !== undefined)
      set.enrollmentRkey = updates.enrollmentRkey ?? null
    if (updates.isService !== undefined) set.isService = updates.isService
    if (updates.custody !== undefined) set.custody = updates.custody
    // `repoHost` alone needs to express "clear it": custody reconciliation
    // must be able to drop a stored repoHost when it flips a user back to
    // 'stratos' custody. `in` sees an explicit `repoHost: undefined`, where
    // `!== undefined` would treat it the same as an omitted key.
    if ('repoHost' in updates) set.repoHost = updates.repoHost ?? null
    if ('capabilityVerdict' in updates)
      set.capabilityVerdict = updates.capabilityVerdict ?? null

    if (Object.keys(set).length > 0) {
      await this.db.update(enrollment).set(set).where(eq(enrollment.did, did))
    }
  }

  /**
   * List enrollments with optional pagination
   * @param options - Pagination options
   * @returns List of enrollments and optional cursor for next page
   */
  async listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 50
    const cursor = options?.cursor

    const conditions = [
      cursor ? gt(enrollment.did, cursor) : undefined,
      options?.activeOnly ? eq(enrollment.active, 'true') : undefined,
    ].filter((c) => c !== undefined)

    const rows = await this.db
      .select()
      .from(enrollment)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(enrollment.did))
      .limit(limit)

    return rows.map(toStoredEnrollment)
  }

  /**
   * List only service enrollments with optional pagination
   * @param options - Pagination options
   * @returns List of service enrollments
   */
  async listServiceEnrollments(options?: {
    limit?: number
    cursor?: string
  }): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 50
    const cursor = options?.cursor

    const condition = cursor
      ? and(eq(enrollment.isService, true), gt(enrollment.did, cursor))
      : eq(enrollment.isService, true)

    const rows = await this.db
      .select()
      .from(enrollment)
      .where(condition)
      .orderBy(asc(enrollment.did))
      .limit(limit)

    return rows.map(toStoredEnrollment)
  }

  /**
   * List active enrollments carrying a given boundary (a space's member list).
   * @param boundary - Boundary to filter by
   * @param options - Pagination options
   * @returns List of active enrollments carrying the boundary
   */
  async listEnrollmentsByBoundary(
    boundary: string,
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 50
    const cursor = options?.cursor

    const conditions = [
      eq(enrollmentBoundary.boundary, boundary),
      eq(enrollment.active, 'true'),
    ]
    if (cursor) conditions.push(gt(enrollment.did, cursor))

    const rows = await this.db
      .select({
        did: enrollment.did,
        enrolledAt: enrollment.enrolledAt,
        pdsEndpoint: enrollment.pdsEndpoint,
        signingKeyDid: enrollment.signingKeyDid,
        active: enrollment.active,
        enrollmentRkey: enrollment.enrollmentRkey,
        isService: enrollment.isService,
        custody: enrollment.custody,
        repoHost: enrollment.repoHost,
        capabilityVerdict: enrollment.capabilityVerdict,
      })
      .from(enrollment)
      .innerJoin(enrollmentBoundary, eq(enrollment.did, enrollmentBoundary.did))
      .where(and(...conditions))
      .orderBy(asc(enrollment.did))
      .limit(limit)

    return rows.map(toStoredEnrollment)
  }

  /**
   * Get the total number of enrollments
   * @returns Total enrollment count
   */
  async enrollmentCount(): Promise<number> {
    const rows = await this.db
      .select({ count: enrollment.did })
      .from(enrollment)
    return rows.length
  }

  /**
   * Get boundaries for a DID
   * @param did - Decentralized Identifier to retrieve boundaries for
   * @returns List of boundaries for the DID
   */
  async getBoundaries(did: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    return rows.map((r) => r.boundary)
  }

  /**
   * Set boundaries for a DID
   * @param did - Decentralized Identifier to set boundaries for
   * @param boundaries - List of boundaries to set
   */
  async setBoundaries(did: string, boundaries: string[]): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    if (boundaries.length > 0) {
      await this.db
        .insert(enrollmentBoundary)
        .values(boundaries.map((boundary) => ({ did, boundary })))
    }
  }

  /**
   * Add a boundary for a DID
   * @param did - Decentralized Identifier to add boundary for
   * @param boundary - Boundary to add
   */
  async addBoundary(did: string, boundary: string): Promise<void> {
    await this.db
      .insert(enrollmentBoundary)
      .values({ did, boundary })
      .onConflictDoNothing()
  }

  /**
   * Remove a boundary for a DID
   * @param did - Decentralized Identifier to remove boundary for
   * @param boundary - Boundary to remove
   */
  async removeBoundary(did: string, boundary: string): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(
        and(
          eq(enrollmentBoundary.did, did),
          eq(enrollmentBoundary.boundary, boundary),
        ),
      )
  }
}
