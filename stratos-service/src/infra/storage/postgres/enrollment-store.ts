import { eq, gt, asc, sql, and } from 'drizzle-orm'
import type {
  Custody,
  EnrollmentStoreReader,
  EnrollmentStoreWriter,
  SpacesCapability,
  StoredEnrollment,
  ListEnrollmentsOptions,
} from '@northskysocial/stratos-core'
import type { ServicePgDb } from '../../../db/pg.js'
import {
  pgEnrollment,
  pgEnrollmentBoundary,
  type PgEnrollment,
} from '../../../db/pg-schema.js'

/**
 * Map a stored enrollment row to the storage-port shape. Rows written before
 * MM-03 have no custody value, so an absent column defaults to 'stratos'.
 */
function toStoredEnrollment(row: PgEnrollment): StoredEnrollment {
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

    return toStoredEnrollment(row)
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

    return rows.map(toStoredEnrollment)
  }

  async listServiceEnrollments(
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 100
    const cursor = options?.cursor

    const condition = cursor
      ? and(eq(pgEnrollment.isService, true), gt(pgEnrollment.did, cursor))
      : eq(pgEnrollment.isService, true)

    const rows = await this.db
      .select()
      .from(pgEnrollment)
      .where(condition)
      .orderBy(asc(pgEnrollment.did))
      .limit(limit)

    return rows.map(toStoredEnrollment)
  }

  /**
   * List active enrollments carrying a given boundary (a space's member list).
   */
  async listEnrollmentsByBoundary(
    boundary: string,
    options?: ListEnrollmentsOptions,
  ): Promise<StoredEnrollment[]> {
    const limit = options?.limit ?? 100
    const cursor = options?.cursor

    const conditions = [
      eq(pgEnrollmentBoundary.boundary, boundary),
      eq(pgEnrollment.active, 'true'),
    ]
    if (cursor) conditions.push(gt(pgEnrollment.did, cursor))

    const rows = await this.db
      .select({
        did: pgEnrollment.did,
        enrolledAt: pgEnrollment.enrolledAt,
        pdsEndpoint: pgEnrollment.pdsEndpoint,
        signingKeyDid: pgEnrollment.signingKeyDid,
        active: pgEnrollment.active,
        enrollmentRkey: pgEnrollment.enrollmentRkey,
        isService: pgEnrollment.isService,
        custody: pgEnrollment.custody,
        repoHost: pgEnrollment.repoHost,
        capabilityVerdict: pgEnrollment.capabilityVerdict,
      })
      .from(pgEnrollment)
      .innerJoin(
        pgEnrollmentBoundary,
        eq(pgEnrollment.did, pgEnrollmentBoundary.did),
      )
      .where(and(...conditions))
      .orderBy(asc(pgEnrollment.did))
      .limit(limit)

    return rows.map(toStoredEnrollment)
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
        enrollmentRkey: data.enrollmentRkey ?? null,
        isService: data.isService ?? false,
        custody: data.custody ?? 'stratos',
        repoHost: data.repoHost ?? null,
        capabilityVerdict: data.capabilityVerdict ?? null,
      })
      .onConflictDoUpdate({
        target: pgEnrollment.did,
        set: {
          enrolledAt: data.enrolledAt,
          pdsEndpoint: data.pdsEndpoint ?? null,
          signingKeyDid: data.signingKeyDid,
          active: data.active ? 'true' : 'false',
          enrollmentRkey: data.enrollmentRkey ?? null,
          isService: data.isService ?? false,
          custody: data.custody ?? 'stratos',
          repoHost: data.repoHost ?? null,
          capabilityVerdict: data.capabilityVerdict ?? null,
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
    await this.db.delete(pgEnrollment).where(eq(pgEnrollment.did, did))
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
    if (updates.signingKeyDid !== undefined) {
      setValues.signingKeyDid = updates.signingKeyDid
    }
    if (updates.active !== undefined) {
      // Stored as text to match the sqlite backend's encoding.
      setValues.active = updates.active ? 'true' : 'false'
    }
    if (updates.enrollmentRkey !== undefined) {
      setValues.enrollmentRkey = updates.enrollmentRkey
    }
    if (updates.isService !== undefined) {
      setValues.isService = updates.isService
    }
    if (updates.custody !== undefined) {
      setValues.custody = updates.custody
    }
    // `repoHost` alone needs to express "clear it": custody reconciliation
    // must be able to drop a stored repoHost when it flips a user back to
    // 'stratos' custody. `in` sees an explicit `repoHost: undefined`, where
    // `!== undefined` would treat it the same as an omitted key.
    if ('repoHost' in updates) {
      setValues.repoHost = updates.repoHost ?? null
    }
    if ('capabilityVerdict' in updates) {
      setValues.capabilityVerdict = updates.capabilityVerdict ?? null
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
