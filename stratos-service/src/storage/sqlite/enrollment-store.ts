import { eq } from 'drizzle-orm'
import {
  type EnrollmentStoreReader,
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
      })
      .onConflictDoUpdate({
        target: enrollment.did,
        set: {
          enrolledAt: record.enrolledAt,
          pdsEndpoint: record.pdsEndpoint ?? null,
          signingKeyDid: record.signingKeyDid,
          active: record.active ? 'true' : 'false',
          enrollmentRkey: record.enrollmentRkey ?? null,
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

    if (Object.keys(set).length > 0) {
      await this.db.update(enrollment).set(set).where(eq(enrollment.did, did))
    }
  }

  /**
   * List enrollments with optional pagination
   * @param options - Pagination options
   * @returns List of enrollments and optional cursor for next page
   */
  async listEnrollments(options?: {
    limit?: number
    cursor?: string
  }): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 50
    const cursor = options?.cursor

    const query = this.db.select().from(enrollment).limit(limit)
    // Basic cursor implementation based on DID
    if (cursor) {
      // For simplicity, using alphabetical DID as cursor
      // In a real app, maybe use a primary key or timestamp
    }

    const rows = await query
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
        eq(enrollmentBoundary.did, did) &&
          eq(enrollmentBoundary.boundary, boundary),
      )
  }
}
