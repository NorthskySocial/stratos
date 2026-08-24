import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { enrollmentPdsSync, type ServiceDb } from '../../../db'
import { pgEnrollmentPdsSync } from '../../../db/pg-schema.js'
import type { ServicePgDb } from '../../../db/pg.js'

/**
 * A durable PDS enrollment-record sync job. One row per actor; boundaries are
 * re-derived from the enrollment store at execution time, so the row carries
 * scheduling state only.
 */
export interface PdsSyncJob {
  did: string
  status: PdsSyncJobStatus
  attemptCount: number
  nextAttemptAt: string
  firstQueuedAt: string
  updatedAt: string
  lastError: string | null
  /**
   * Fencing token. Every fresh intent bumps it. An attempt carries the
   * generation it started from and only writes bookkeeping while that
   * generation is still current, so an attempt that a later mutation
   * superseded cannot clear or delay the newer job.
   */
  generation: number
}

/**
 * `'pending'` jobs are retried by the worker; `'failed'` is terminal and only
 * revived by a fresh admin mutation (via {@link PdsSyncQueueStore.upsertPending})
 * or by an operator (via {@link PdsSyncQueueStore.requeueFailed}).
 */
export type PdsSyncJobStatus = 'pending' | 'failed'

/**
 * Persistence for the PDS enrollment-record sync queue.
 */
export interface PdsSyncQueueStore {
  /**
   * Record durable sync intent for an actor. Resets an existing row (including
   * a terminal `'failed'` one) to `'pending'` with `nextAttemptAt = now` and a
   * fresh attempt budget, preserving `firstQueuedAt`.
   *
   * @returns The row's new generation. The caller passes it to the attempt it
   * starts, so that attempt can fence its own bookkeeping.
   */
  upsertPending(did: string): Promise<number>
  /** Jobs with `status = 'pending'` and `nextAttemptAt <= now`. */
  listDue(now: string, limit: number): Promise<PdsSyncJob[]>
  /** Schedule a retry, only while `generation` is still current. */
  markRetry(
    did: string,
    generation: number,
    attemptCount: number,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void>
  /** Terminal failure, only while `generation` is still current. */
  markFailed(did: string, generation: number, lastError: string): Promise<void>
  /**
   * Clear a completed job, but only while `generation` is still current. A
   * mutation that landed during the attempt has already bumped the generation,
   * so its job survives and the ticker converges on the newer state.
   *
   * @returns `true` when the row was cleared, `false` when it was superseded.
   */
  removeIfCurrent(did: string, generation: number): Promise<boolean>
  /** Unconditional delete. Used when the actor unenrolls. */
  remove(did: string): Promise<void>
  /** Reset every terminal job to pending. @returns The number revived. */
  requeueFailed(): Promise<number>
  /** All jobs, for the operator observability endpoint. */
  list(): Promise<PdsSyncJob[]>
}

function nowIso(): string {
  return new Date().toISOString()
}

interface PdsSyncRow {
  did: string
  status: string
  attemptCount: number
  nextAttemptAt: string
  firstQueuedAt: string
  updatedAt: string
  lastError: string | null
  generation: number
}

function toJob(row: PdsSyncRow): PdsSyncJob {
  return {
    did: row.did,
    status: row.status as PdsSyncJobStatus,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    firstQueuedAt: row.firstQueuedAt,
    updatedAt: row.updatedAt,
    lastError: row.lastError,
    generation: row.generation,
  }
}

/**
 * SQLite-backed PDS sync queue store.
 */
export class SqlitePdsSyncQueueStore implements PdsSyncQueueStore {
  constructor(private db: ServiceDb) {}

  async upsertPending(did: string): Promise<number> {
    const now = nowIso()
    const rows = await this.db
      .insert(enrollmentPdsSync)
      .values({
        did,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        firstQueuedAt: now,
        updatedAt: now,
        lastError: null,
        generation: 1,
      })
      .onConflictDoUpdate({
        target: enrollmentPdsSync.did,
        set: {
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: now,
          updatedAt: now,
          lastError: null,
          generation: sql`${enrollmentPdsSync.generation} + 1`,
        },
      })
      .returning({ generation: enrollmentPdsSync.generation })
    return rows[0].generation
  }

  async listDue(now: string, limit: number): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(enrollmentPdsSync)
      .where(
        and(
          eq(enrollmentPdsSync.status, 'pending'),
          lte(enrollmentPdsSync.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(enrollmentPdsSync.nextAttemptAt))
      .limit(limit)
    return rows.map(toJob)
  }

  async markRetry(
    did: string,
    generation: number,
    attemptCount: number,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    await this.db
      .update(enrollmentPdsSync)
      .set({
        status: 'pending',
        attemptCount,
        nextAttemptAt,
        lastError,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(enrollmentPdsSync.did, did),
          eq(enrollmentPdsSync.generation, generation),
        ),
      )
  }

  async markFailed(
    did: string,
    generation: number,
    lastError: string,
  ): Promise<void> {
    await this.db
      .update(enrollmentPdsSync)
      .set({ status: 'failed', lastError, updatedAt: nowIso() })
      .where(
        and(
          eq(enrollmentPdsSync.did, did),
          eq(enrollmentPdsSync.generation, generation),
        ),
      )
  }

  async removeIfCurrent(did: string, generation: number): Promise<boolean> {
    const rows = await this.db
      .delete(enrollmentPdsSync)
      .where(
        and(
          eq(enrollmentPdsSync.did, did),
          eq(enrollmentPdsSync.generation, generation),
        ),
      )
      .returning({ did: enrollmentPdsSync.did })
    return rows.length > 0
  }

  async remove(did: string): Promise<void> {
    await this.db.delete(enrollmentPdsSync).where(eq(enrollmentPdsSync.did, did))
  }

  async requeueFailed(): Promise<number> {
    const now = nowIso()
    const rows = await this.db
      .update(enrollmentPdsSync)
      .set({
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        updatedAt: now,
        lastError: null,
        generation: sql`${enrollmentPdsSync.generation} + 1`,
      })
      .where(eq(enrollmentPdsSync.status, 'failed'))
      .returning({ did: enrollmentPdsSync.did })
    return rows.length
  }

  async list(): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(enrollmentPdsSync)
      .orderBy(asc(enrollmentPdsSync.firstQueuedAt))
    return rows.map(toJob)
  }
}

/**
 * PostgreSQL-backed PDS sync queue store.
 */
export class PgPdsSyncQueueStore implements PdsSyncQueueStore {
  constructor(private db: ServicePgDb) {}

  async upsertPending(did: string): Promise<number> {
    const now = nowIso()
    const rows = await this.db
      .insert(pgEnrollmentPdsSync)
      .values({
        did,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        firstQueuedAt: now,
        updatedAt: now,
        lastError: null,
        generation: 1,
      })
      .onConflictDoUpdate({
        target: pgEnrollmentPdsSync.did,
        set: {
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: now,
          updatedAt: now,
          lastError: null,
          generation: sql`${pgEnrollmentPdsSync.generation} + 1`,
        },
      })
      .returning({ generation: pgEnrollmentPdsSync.generation })
    return rows[0].generation
  }

  async listDue(now: string, limit: number): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(pgEnrollmentPdsSync)
      .where(
        and(
          eq(pgEnrollmentPdsSync.status, 'pending'),
          lte(pgEnrollmentPdsSync.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(pgEnrollmentPdsSync.nextAttemptAt))
      .limit(limit)
    return rows.map(toJob)
  }

  async markRetry(
    did: string,
    generation: number,
    attemptCount: number,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    await this.db
      .update(pgEnrollmentPdsSync)
      .set({
        status: 'pending',
        attemptCount,
        nextAttemptAt,
        lastError,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(pgEnrollmentPdsSync.did, did),
          eq(pgEnrollmentPdsSync.generation, generation),
        ),
      )
  }

  async markFailed(
    did: string,
    generation: number,
    lastError: string,
  ): Promise<void> {
    await this.db
      .update(pgEnrollmentPdsSync)
      .set({ status: 'failed', lastError, updatedAt: nowIso() })
      .where(
        and(
          eq(pgEnrollmentPdsSync.did, did),
          eq(pgEnrollmentPdsSync.generation, generation),
        ),
      )
  }

  async removeIfCurrent(did: string, generation: number): Promise<boolean> {
    const rows = await this.db
      .delete(pgEnrollmentPdsSync)
      .where(
        and(
          eq(pgEnrollmentPdsSync.did, did),
          eq(pgEnrollmentPdsSync.generation, generation),
        ),
      )
      .returning({ did: pgEnrollmentPdsSync.did })
    return rows.length > 0
  }

  async remove(did: string): Promise<void> {
    await this.db
      .delete(pgEnrollmentPdsSync)
      .where(eq(pgEnrollmentPdsSync.did, did))
  }

  async requeueFailed(): Promise<number> {
    const now = nowIso()
    const rows = await this.db
      .update(pgEnrollmentPdsSync)
      .set({
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        updatedAt: now,
        lastError: null,
        generation: sql`${pgEnrollmentPdsSync.generation} + 1`,
      })
      .where(eq(pgEnrollmentPdsSync.status, 'failed'))
      .returning({ did: pgEnrollmentPdsSync.did })
    return rows.length
  }

  async list(): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(pgEnrollmentPdsSync)
      .orderBy(asc(pgEnrollmentPdsSync.firstQueuedAt))
    return rows.map(toJob)
  }
}
