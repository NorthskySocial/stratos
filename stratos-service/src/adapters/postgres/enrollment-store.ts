import { eq, gt, asc, sql, and } from 'drizzle-orm'
import type {
  EnrollmentStoreReader,
  EnrollmentStoreWriter,
  StoredEnrollment,
  ListEnrollmentsOptions,
} from '@northskysocial/stratos-core'
import type { ServicePgDb } from '../../db/pg.js'
import { pgEnrollment, pgEnrollmentBoundary } from '../../db/pg-schema.js'

export class PgEnrollmentStoreReader implements EnrollmentStoreReader {
  constructor(protected db: ServicePgDb) {}

  async isEnrolled(did: string): Promise<boolean> {
    const rows = await this.db
      .select({ did: pgEnrollment.did, active: pgEnrollment.active })
      .from(pgEnrollment)
      .where(eq(pgEnrollment.did, did))
      .limit(1)

    return rows.length > 0 && rows[0].active === 'true'
  }

  async getEnrollment(did: string): Promise<StoredEnrollment | null> {
    const rows = await this.db
      .select()
      .from(pgEnrollment)
      .where(eq(pgEnrollment.did, did))
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return {
      did: row.did,
      enrolledAt: row.enrolledAt,
      pdsEndpoint: row.pdsEndpoint ?? undefined,
      signingKeyDid: row.signingKeyDid,
      active: row.active === 'true',
    }
  }

  async listEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 100
    const cursor = options?.cursor

    let query = this.db.select().from(pgEnrollment)

    if (cursor) {
      query = query.where(gt(pgEnrollment.did, cursor)) as typeof query
    }

    const rows = await query.orderBy(asc(pgEnrollment.did)).limit(limit)

    return rows.map((row) => ({
      did: row.did,
      enrolledAt: row.enrolledAt,
      pdsEndpoint: row.pdsEndpoint ?? undefined,
      signingKeyDid: row.signingKeyDid,
      active: row.active === 'true',
    }))
  }

  async enrollmentCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(pgEnrollment)

    return Number(rows[0]?.count ?? 0)
  }

  async getBoundaries(did: string): Promise<string[]> {
    const rows = await this.db
      .select({ boundary: pgEnrollmentBoundary.boundary })
      .from(pgEnrollmentBoundary)
      .where(eq(pgEnrollmentBoundary.did, did))

    return rows.map((r) => r.boundary)
  }
}

export class PgEnrollmentStoreWriter
  extends PgEnrollmentStoreReader
  implements EnrollmentStoreWriter
{
  async enroll(data: StoredEnrollment): Promise<void> {
    await this.db
      .insert(pgEnrollment)
      .values({
        did: data.did,
        enrolledAt: data.enrolledAt,
        pdsEndpoint: data.pdsEndpoint ?? null,
        signingKeyDid: data.signingKeyDid,
        active: data.active ? 'true' : 'false',
      })
      .onConflictDoUpdate({
        target: pgEnrollment.did,
        set: {
          enrolledAt: data.enrolledAt,
          pdsEndpoint: data.pdsEndpoint ?? null,
          signingKeyDid: data.signingKeyDid,
          active: data.active ? 'true' : 'false',
        },
      })

    if (data.boundaries && data.boundaries.length > 0) {
      await this.setBoundaries(data.did, data.boundaries)
    }
  }

  async unenroll(did: string): Promise<void> {
    await this.db
      .delete(pgEnrollmentBoundary)
      .where(eq(pgEnrollmentBoundary.did, did))
    await this.db
      .update(pgEnrollment)
      .set({ active: 'false' })
      .where(eq(pgEnrollment.did, did))
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
        .update(pgEnrollment)
        .set(setValues)
        .where(eq(pgEnrollment.did, did))
    }
  }

  async setBoundaries(did: string, boundaries: string[]): Promise<void> {
    await this.db
      .delete(pgEnrollmentBoundary)
      .where(eq(pgEnrollmentBoundary.did, did))

    if (boundaries.length > 0) {
      await this.db
        .insert(pgEnrollmentBoundary)
        .values(boundaries.map((boundary) => ({ did, boundary })))
    }
  }

  async addBoundary(did: string, boundary: string): Promise<void> {
    await this.db
      .insert(pgEnrollmentBoundary)
      .values({ did, boundary })
      .onConflictDoNothing()
  }

  async removeBoundary(did: string, boundary: string): Promise<void> {
    await this.db
      .delete(pgEnrollmentBoundary)
      .where(
        and(
          eq(pgEnrollmentBoundary.did, did),
          eq(pgEnrollmentBoundary.boundary, boundary),
        ),
      )
  }
}
