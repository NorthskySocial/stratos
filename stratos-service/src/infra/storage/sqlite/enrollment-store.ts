/**
 * SQLite Enrollment Store Adapter
 *
 * Implements EnrollmentStoreReader/Writer for SQLite backend.
 * Uses the service-level database (not per-actor).
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type {
  EnrollmentStoreReader,
  EnrollmentStoreWriter,
  ListEnrollmentsOptions,
  StoredEnrollment,
} from '@northskysocial/stratos-core'
import { enrollment, enrollmentBoundary, ServiceDb } from '../../../db'

/**
 * SQLite implementation of EnrollmentStoreReader
 */
export class SqliteEnrollmentStoreReader implements EnrollmentStoreReader {
  constructor(protected db: ServiceDb) {}

  /**
   * Check if a DID is enrolled.
   * @param did - The Decentralized Identifier (DID) to check.
   * @returns True if the DID is enrolled, false otherwise.
   */
  async isEnrolled(did: string): Promise<boolean> {
    const rows = await this.db
      .select({ did: enrollment.did, active: enrollment.active })
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    return rows.length > 0 && rows[0].active === 'true'
  }

  /**
   * Get enrollment details for a given DID.
   * @param did - The Decentralized Identifier (DID) to retrieve enrollment for.
   * @returns Enrollment details if found, null otherwise.
   */
  async getEnrollment(did: string): Promise<StoredEnrollment | null> {
    const rows = await this.db
      .select()
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return {
      did: row.did,
      enrolledAt: row.enrolledAt,
      pdsEndpoint: row.pdsEndpoint ?? undefined,
      signingKeyDid: row.signingKeyDid,
      active: row.active === 'true',
      enrollmentRkey: row.enrollmentRkey ?? undefined,
    }
  }

  /**
   * List enrollments with optional pagination.
   * @param options - Pagination options including limit and cursor.
   * @returns Array of enrollment details.
   */
  async listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 100
    const cursor = options?.cursor

    let query = this.db.select().from(enrollment)

    if (cursor) {
      query = query.where(gt(enrollment.did, cursor)) as typeof query
    }

    const rows = await query.orderBy(asc(enrollment.did)).limit(limit)

    return rows.map((row) => ({
      did: row.did,
      enrolledAt: row.enrolledAt,
      pdsEndpoint: row.pdsEndpoint ?? undefined,
      signingKeyDid: row.signingKeyDid,
      active: row.active === 'true',
      enrollmentRkey: row.enrollmentRkey ?? undefined,
    }))
  }

  /**
   * Get the total number of enrollments.
   * @returns Total number of enrollments.
   */
  async enrollmentCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(enrollment)

    return rows[0]?.count ?? 0
  }

  /**
   * Get the boundaries for a given DID.
   * @param did - The DID to retrieve boundaries for.
   * @returns Array of boundary strings.
   */
  async getBoundaries(did: string): Promise<string[]> {
    const rows = await this.db
      .select({ boundary: enrollmentBoundary.boundary })
      .from(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    return rows.map((r) => r.boundary)
  }
}

/**
 * SQLite implementation of EnrollmentStoreWriter
 */
export class SqliteEnrollmentStoreWriter
  extends SqliteEnrollmentStoreReader
  implements EnrollmentStoreWriter
{
  /**
   * Enroll a new DID with provided data.
   * @param data - Enrollment data to be stored.
   */
  async enroll(data: StoredEnrollment): Promise<void> {
    await this.db
      .insert(enrollment)
      .values({
        did: data.did,
        enrolledAt: data.enrolledAt,
        pdsEndpoint: data.pdsEndpoint ?? null,
        signingKeyDid: data.signingKeyDid,
        active: data.active ? 'true' : 'false',
        enrollmentRkey: data.enrollmentRkey ?? null,
      })
      .onConflictDoUpdate({
        target: enrollment.did,
        set: {
          enrolledAt: data.enrolledAt,
          pdsEndpoint: data.pdsEndpoint ?? null,
          signingKeyDid: data.signingKeyDid,
          active: data.active ? 'true' : 'false',
          enrollmentRkey: data.enrollmentRkey ?? null,
        },
      })

    if (data.boundaries && data.boundaries.length > 0) {
      await this.setBoundaries(data.did, data.boundaries)
    }
  }

  /**
   * Unenroll a DID by removing all associated data.
   * @param did - The DID to unenroll.
   */
  async unenroll(did: string): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    await this.db.delete(enrollment).where(eq(enrollment.did, did))
  }

  /**
   * Update enrollment details for a DID.
   * @param did - The DID to update.
   * @param updates - Fields to update.
   */
  async updateEnrollment(
    did: string,
    updates: Partial<Omit<StoredEnrollment, 'did'>>,
  ): Promise<void> {
    const setValues: Record<string, unknown> = {}

    if (updates.enrolledAt !== undefined) {
      setValues.enrolledAt = updates.enrolledAt
    }
    if (updates.pdsEndpoint !== undefined) {
      setValues.pdsEndpoint = updates.pdsEndpoint
    }
    if (updates.signingKeyDid !== undefined) {
      setValues.signingKeyDid = updates.signingKeyDid
    }
    if (updates.active !== undefined) {
      setValues.active = updates.active ? 'true' : 'false'
    }
    if (updates.enrollmentRkey !== undefined) {
      setValues.enrollmentRkey = updates.enrollmentRkey
    }

    if (Object.keys(setValues).length > 0) {
      await this.db
        .update(enrollment)
        .set(setValues)
        .where(eq(enrollment.did, did))
    }
  }

  /**
   * Set boundaries for a DID.
   * @param did - The DID to set boundaries for.
   * @param boundaries - Array of boundary strings.
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
   * Add a boundary to a DID's boundaries.
   * @param did - The DID to add the boundary to.
   * @param boundary - The boundary string to add.
   */
  async addBoundary(did: string, boundary: string): Promise<void> {
    await this.db
      .insert(enrollmentBoundary)
      .values({ did, boundary })
      .onConflictDoNothing()
  }

  /**
   * Remove a boundary from a DID's boundaries.
   * @param did - The DID to remove the boundary from.
   * @param boundary - The boundary string to remove.
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
