import { and, asc, eq, lte } from 'drizzle-orm'
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
}

/**
 * `'pending'` jobs are retried by the worker; `'failed'` is terminal and only
 * revived by a fresh admin mutation (via {@link PdsSyncQueueStore.upsertPending}).
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
   */
  upsertPending(did: string): Promise<void>
  /** Jobs with `status = 'pending'` and `nextAttemptAt <= now`. */
  listDue(now: string, limit: number): Promise<PdsSyncJob[]>
  markRetry(
    did: string,
    attemptCount: number,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void>
  /** Terminal failure: the ticker never retries the row again. */
  markFailed(did: string, lastError: string): Promise<void>
  /** Job completed or became obsolete (actor unenrolled). */
  remove(did: string): Promise<void>
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
  }
}

/**
 * SQLite-backed PDS sync queue store.
 */
export class SqlitePdsSyncQueueStore implements PdsSyncQueueStore {
  constructor(private db: ServiceDb) {}

  async upsertPending(did: string): Promise<void> {
    const now = nowIso()
    await this.db
      .insert(enrollmentPdsSync)
      .values({
        did,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        firstQueuedAt: now,
        updatedAt: now,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: enrollmentPdsSync.did,
        set: {
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: now,
          updatedAt: now,
          lastError: null,
        },
      })
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
      .where(eq(enrollmentPdsSync.did, did))
  }

  async markFailed(did: string, lastError: string): Promise<void> {
    await this.db
      .update(enrollmentPdsSync)
      .set({ status: 'failed', lastError, updatedAt: nowIso() })
      .where(eq(enrollmentPdsSync.did, did))
  }

  async remove(did: string): Promise<void> {
    await this.db
      .delete(enrollmentPdsSync)
      .where(eq(enrollmentPdsSync.did, did))
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

  async upsertPending(did: string): Promise<void> {
    const now = nowIso()
    await this.db
      .insert(pgEnrollmentPdsSync)
      .values({
        did,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        firstQueuedAt: now,
        updatedAt: now,
        lastError: null,
      })
      .onConflictDoUpdate({
        target: pgEnrollmentPdsSync.did,
        set: {
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: now,
          updatedAt: now,
          lastError: null,
        },
      })
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
      .where(eq(pgEnrollmentPdsSync.did, did))
  }

  async markFailed(did: string, lastError: string): Promise<void> {
    await this.db
      .update(pgEnrollmentPdsSync)
      .set({ status: 'failed', lastError, updatedAt: nowIso() })
      .where(eq(pgEnrollmentPdsSync.did, did))
  }

  async remove(did: string): Promise<void> {
    await this.db
      .delete(pgEnrollmentPdsSync)
      .where(eq(pgEnrollmentPdsSync.did, did))
  }

  async list(): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(pgEnrollmentPdsSync)
      .orderBy(asc(pgEnrollmentPdsSync.firstQueuedAt))
    return rows.map(toJob)
  }
}
