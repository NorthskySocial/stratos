import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm'
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
export type PdsSyncJobStatus = 'pending' | 'failed' | 'completed' | 'cancelled'

/**
 * Persistence for the PDS enrollment-record sync queue.
 */
export interface PdsSyncQueueStore {
  /** Bounded aggregate queue state for metrics; it never reads queue pages. */
  getStats?(): Promise<PdsSyncQueueStats>
  /**
   * Record durable sync intent for an actor. Resets an existing row (including
   * a terminal `'failed'` one) to `'pending'` with `nextAttemptAt = now` and a
   * fresh attempt budget, preserving `firstQueuedAt`.
   *
   * @returns The row's new generation. The caller passes it to the attempt it
   * starts, so that attempt can fence its own bookkeeping.
   */
  upsertPending(did: string): Promise<number>
  /** Check that one pending generation still owns the actor's sync intent. */
  isPending(did: string, generation: number): Promise<boolean>
  /**
   * Claim one due job and lease it until `leaseUntil`. The claim advances the
   * generation so an expired worker cannot change queue state after a reclaim.
   */
  claimDue(now: string, leaseUntil: string): Promise<PdsSyncJob | undefined>
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
  /** Mark a job completed only while `generation` is still current. */
  markCompleted(did: string, generation: number): Promise<boolean>
  /**
   * Fence an actor's queued work before unenrollment. Returns the cancellation
   * generation, or `undefined` when no queued work exists.
   */
  markCancelled(did: string): Promise<number | undefined>
  /** Reset every terminal job to pending. @returns The number revived. */
  requeueFailed(): Promise<number>
  /**
   * One bounded page of jobs for the operator observability endpoint,
   * ordered by `(firstQueuedAt, did)`. Pass the last row of the previous
   * page as `after` to continue. Bounded so a fleet-wide failure cannot
   * make one read load the whole backlog.
   */
  list(limit: number, after?: PdsSyncPageKey): Promise<PdsSyncJob[]>
}

export interface PdsSyncQueueStats {
  pending: number
  failed: number
  oldestPendingAgeSeconds: number
}

/** Keyset cursor: the sort key of the last row of the previous page. */
export interface PdsSyncPageKey {
  firstQueuedAt: string
  did: string
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

  async getStats(): Promise<PdsSyncQueueStats> {
    const [row] = await this.db
      .select({
        pending: sql<number>`count(case when ${enrollmentPdsSync.status} = 'pending' then 1 end)`,
        failed: sql<number>`count(case when ${enrollmentPdsSync.status} = 'failed' then 1 end)`,
        oldestPendingAt: sql<
          string | null
        >`min(case when ${enrollmentPdsSync.status} = 'pending' then ${enrollmentPdsSync.firstQueuedAt} end)`,
      })
      .from(enrollmentPdsSync)
    return queueStats(row)
  }

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

  async isPending(did: string, generation: number): Promise<boolean> {
    const rows = await this.db
      .select({ did: enrollmentPdsSync.did })
      .from(enrollmentPdsSync)
      .where(
        and(
          eq(enrollmentPdsSync.did, did),
          eq(enrollmentPdsSync.generation, generation),
          eq(enrollmentPdsSync.status, 'pending'),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async claimDue(
    now: string,
    leaseUntil: string,
  ): Promise<PdsSyncJob | undefined> {
    const candidate = this.db
      .select({ did: enrollmentPdsSync.did })
      .from(enrollmentPdsSync)
      .where(
        and(
          eq(enrollmentPdsSync.status, 'pending'),
          lte(enrollmentPdsSync.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(enrollmentPdsSync.nextAttemptAt))
      .limit(1)
    const rows = await this.db
      .update(enrollmentPdsSync)
      .set({
        nextAttemptAt: leaseUntil,
        updatedAt: now,
        generation: sql`${enrollmentPdsSync.generation} + 1`,
      })
      .where(
        and(
          eq(enrollmentPdsSync.status, 'pending'),
          lte(enrollmentPdsSync.nextAttemptAt, now),
          inArray(enrollmentPdsSync.did, candidate),
        ),
      )
      .returning()
    return rows[0] ? toJob(rows[0]) : undefined
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
          eq(enrollmentPdsSync.status, 'pending'),
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
          eq(enrollmentPdsSync.status, 'pending'),
        ),
      )
  }

  async markCompleted(did: string, generation: number): Promise<boolean> {
    const rows = await this.db
      .update(enrollmentPdsSync)
      .set({ status: 'completed', updatedAt: nowIso() })
      .where(
        and(
          eq(enrollmentPdsSync.did, did),
          eq(enrollmentPdsSync.generation, generation),
          eq(enrollmentPdsSync.status, 'pending'),
        ),
      )
      .returning({ did: enrollmentPdsSync.did })
    return rows.length > 0
  }

  async markCancelled(did: string): Promise<number | undefined> {
    const rows = await this.db
      .update(enrollmentPdsSync)
      .set({
        status: 'cancelled',
        updatedAt: nowIso(),
        generation: sql`${enrollmentPdsSync.generation} + 1`,
      })
      .where(eq(enrollmentPdsSync.did, did))
      .returning({ generation: enrollmentPdsSync.generation })
    return rows[0]?.generation
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

  async list(limit: number, after?: PdsSyncPageKey): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(enrollmentPdsSync)
      .where(
        and(
          inArray(enrollmentPdsSync.status, ['pending', 'failed']),
          after
            ? or(
                gt(enrollmentPdsSync.firstQueuedAt, after.firstQueuedAt),
                and(
                  eq(enrollmentPdsSync.firstQueuedAt, after.firstQueuedAt),
                  gt(enrollmentPdsSync.did, after.did),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(enrollmentPdsSync.firstQueuedAt), asc(enrollmentPdsSync.did))
      .limit(limit)
    return rows.map(toJob)
  }
}

/**
 * PostgreSQL-backed PDS sync queue store.
 */
export class PgPdsSyncQueueStore implements PdsSyncQueueStore {
  constructor(private db: ServicePgDb) {}

  async getStats(): Promise<PdsSyncQueueStats> {
    const [row] = await this.db
      .select({
        pending: sql<number>`count(case when ${pgEnrollmentPdsSync.status} = 'pending' then 1 end)`,
        failed: sql<number>`count(case when ${pgEnrollmentPdsSync.status} = 'failed' then 1 end)`,
        oldestPendingAt: sql<
          string | null
        >`min(case when ${pgEnrollmentPdsSync.status} = 'pending' then ${pgEnrollmentPdsSync.firstQueuedAt} end)`,
      })
      .from(pgEnrollmentPdsSync)
    return queueStats(row)
  }

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

  async isPending(did: string, generation: number): Promise<boolean> {
    const rows = await this.db
      .select({ did: pgEnrollmentPdsSync.did })
      .from(pgEnrollmentPdsSync)
      .where(
        and(
          eq(pgEnrollmentPdsSync.did, did),
          eq(pgEnrollmentPdsSync.generation, generation),
          eq(pgEnrollmentPdsSync.status, 'pending'),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async claimDue(
    now: string,
    leaseUntil: string,
  ): Promise<PdsSyncJob | undefined> {
    const candidate = this.db
      .select({ did: pgEnrollmentPdsSync.did })
      .from(pgEnrollmentPdsSync)
      .where(
        and(
          eq(pgEnrollmentPdsSync.status, 'pending'),
          lte(pgEnrollmentPdsSync.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(pgEnrollmentPdsSync.nextAttemptAt))
      .limit(1)
    const rows = await this.db
      .update(pgEnrollmentPdsSync)
      .set({
        nextAttemptAt: leaseUntil,
        updatedAt: now,
        generation: sql`${pgEnrollmentPdsSync.generation} + 1`,
      })
      .where(
        and(
          eq(pgEnrollmentPdsSync.status, 'pending'),
          lte(pgEnrollmentPdsSync.nextAttemptAt, now),
          inArray(pgEnrollmentPdsSync.did, candidate),
        ),
      )
      .returning()
    return rows[0] ? toJob(rows[0]) : undefined
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
          eq(pgEnrollmentPdsSync.status, 'pending'),
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
          eq(pgEnrollmentPdsSync.status, 'pending'),
        ),
      )
  }

  async markCompleted(did: string, generation: number): Promise<boolean> {
    const rows = await this.db
      .update(pgEnrollmentPdsSync)
      .set({ status: 'completed', updatedAt: nowIso() })
      .where(
        and(
          eq(pgEnrollmentPdsSync.did, did),
          eq(pgEnrollmentPdsSync.generation, generation),
          eq(pgEnrollmentPdsSync.status, 'pending'),
        ),
      )
      .returning({ did: pgEnrollmentPdsSync.did })
    return rows.length > 0
  }

  async markCancelled(did: string): Promise<number | undefined> {
    const rows = await this.db
      .update(pgEnrollmentPdsSync)
      .set({
        status: 'cancelled',
        updatedAt: nowIso(),
        generation: sql`${pgEnrollmentPdsSync.generation} + 1`,
      })
      .where(eq(pgEnrollmentPdsSync.did, did))
      .returning({ generation: pgEnrollmentPdsSync.generation })
    return rows[0]?.generation
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

  async list(limit: number, after?: PdsSyncPageKey): Promise<PdsSyncJob[]> {
    const rows = await this.db
      .select()
      .from(pgEnrollmentPdsSync)
      .where(
        and(
          inArray(pgEnrollmentPdsSync.status, ['pending', 'failed']),
          after
            ? or(
                gt(pgEnrollmentPdsSync.firstQueuedAt, after.firstQueuedAt),
                and(
                  eq(pgEnrollmentPdsSync.firstQueuedAt, after.firstQueuedAt),
                  gt(pgEnrollmentPdsSync.did, after.did),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(pgEnrollmentPdsSync.firstQueuedAt),
        asc(pgEnrollmentPdsSync.did),
      )
      .limit(limit)
    return rows.map(toJob)
  }
}

function queueStats(row: {
  pending: number
  failed: number
  oldestPendingAt: string | null
}): PdsSyncQueueStats {
  const oldest = row.oldestPendingAt ? Date.parse(row.oldestPendingAt) : NaN
  return {
    pending: Number(row.pending),
    failed: Number(row.failed),
    oldestPendingAgeSeconds: Number.isNaN(oldest)
      ? 0
      : Math.max(0, (Date.now() - oldest) / 1_000),
  }
}
