/**
 * SQLite Enrollment Store Adapter
 *
 * Implements EnrollmentStoreReader/Writer for SQLite backend.
 * Uses the service-level database (not per-actor).
 */
import { eq, gt, asc, sql, and } from 'drizzle-orm'
import type {
  EnrollmentStoreReader,
  EnrollmentStoreWriter,
  StoredEnrollment,
  ListEnrollmentsOptions,
} from '@northskysocial/stratos-core'
import type { ServiceDb } from '../../db/index.js'
import { enrollment, enrollmentBoundary } from '../../db/schema.js'

/**
 * SQLite implementation of EnrollmentStoreReader
 */
export class SqliteEnrollmentStoreReader implements EnrollmentStoreReader {
  constructor(protected db: ServiceDb) {}

  async isEnrolled(did: string): Promise<boolean> {
    const rows = await this.db
      .select({ did: enrollment.did })
      .from(enrollment)
      .where(eq(enrollment.did, did))
      .limit(1)

    return rows.length > 0
  }

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
    }
  }

  async listEnrollments(options?: ListEnrollmentsOptions): Promise<StoredEnrollment[]> {
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
    }))
  }

  async enrollmentCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(enrollment)

    return rows[0]?.count ?? 0
  }

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
  async enroll(data: StoredEnrollment): Promise<void> {
    await this.db
      .insert(enrollment)
      .values({
        did: data.did,
        enrolledAt: data.enrolledAt,
        pdsEndpoint: data.pdsEndpoint ?? null,
      })
      .onConflictDoUpdate({
        target: enrollment.did,
        set: {
          enrolledAt: data.enrolledAt,
          pdsEndpoint: data.pdsEndpoint ?? null,
        },
      })

    if (data.boundaries && data.boundaries.length > 0) {
      await this.setBoundaries(data.did, data.boundaries)
    }
  }

  async unenroll(did: string): Promise<void> {
    await this.db.delete(enrollmentBoundary).where(eq(enrollmentBoundary.did, did))
    await this.db.delete(enrollment).where(eq(enrollment.did, did))
  }

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

    if (Object.keys(setValues).length > 0) {
      await this.db
        .update(enrollment)
        .set(setValues)
        .where(eq(enrollment.did, did))
    }
  }

  async setBoundaries(did: string, boundaries: string[]): Promise<void> {
    await this.db
      .delete(enrollmentBoundary)
      .where(eq(enrollmentBoundary.did, did))

    if (boundaries.length > 0) {
      await this.db.insert(enrollmentBoundary).values(
        boundaries.map((boundary) => ({ did, boundary })),
      )
    }
  }

  async addBoundary(did: string, boundary: string): Promise<void> {
    await this.db
      .insert(enrollmentBoundary)
      .values({ did, boundary })
      .onConflictDoNothing()
  }

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
