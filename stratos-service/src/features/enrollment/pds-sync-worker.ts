import type { Logger } from '@northskysocial/stratos-core'
import {
  classifyPdsSyncError,
  type PdsEnrollmentSyncResult,
} from './internal/pds-enrollment-sync.js'
import type {
  PdsSyncJob,
  PdsSyncQueueStore,
} from './internal/pds-sync-store.js'

/**
 * Scheduling knobs for the PDS enrollment sync worker.
 */
export interface PdsSyncWorkerConfig {
  tickMs: number
  backoffBaseMs: number
  backoffCapMs: number
  maxAttempts: number
  /** Jobs claimed per tick; volume is admin-mutation-scale. */
  claimLimit: number
}

/**
 * Dependencies for the PDS enrollment sync worker.
 */
export interface PdsSyncWorkerDeps {
  queue: PdsSyncQueueStore
  sync(did: string): Promise<PdsEnrollmentSyncResult>
  logger?: Logger
}

/** Max random jitter added to each backoff delay. */
const BACKOFF_JITTER_MS = 1_000

/** The unit of work an attempt fences itself against. */
type AttemptJob = Pick<PdsSyncJob, 'did' | 'attemptCount' | 'generation'>

/**
 * Durable retry worker for PDS enrollment-record sync jobs.
 *
 * A ticker executes due `'pending'` jobs with capped exponential backoff.
 * Terminal failures (expired/revoked OAuth sessions, attempt exhaustion) are
 * marked `'failed'` and surfaced via an error log plus the observability
 * endpoint; a fresh admin mutation or an operator requeue revives them.
 *
 * Every attempt carries the generation it started from and fences all of its
 * queue writes on it, so a mutation that lands mid-attempt keeps its own job
 * rather than being cleared by the attempt it superseded.
 */
export class PdsEnrollmentSyncWorker {
  private timer?: NodeJS.Timeout
  private ticking = false
  private inFlight = new Map<string, Promise<'ok' | 'deferred'>>()

  constructor(
    private deps: PdsSyncWorkerDeps,
    private config: PdsSyncWorkerConfig,
  ) {}

  /**
   * Start the tick loop. The first tick runs immediately so jobs whose
   * `nextAttemptAt` passed while the service was down are recovered on
   * startup. The interval is unref'd and never keeps the process alive.
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.config.tickMs)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Record durable sync intent for an actor. Called before the local mutation
   * commits, so a crash in between leaves a pending row rather than silence;
   * the job re-derives boundaries when it runs, so replaying it is harmless.
   *
   * @returns The generation to pass to the matching {@link kick}.
   */
  async enqueue(did: string): Promise<number> {
    return this.deps.queue.upsertPending(did)
  }

  /**
   * Run one inline attempt for a just-enqueued actor. Returns `'ok'` when the
   * PDS record was written (or the job was obsolete); `'deferred'` when the
   * attempt failed and the queue's retry/terminal bookkeeping was applied.
   */
  async kick(did: string, generation: number): Promise<'ok' | 'deferred'> {
    return this.attempt({ did, attemptCount: 0, generation })
  }

  /**
   * Drop an actor's job and wait for any attempt already in flight to settle.
   * Unenrollment calls this before it deletes the PDS enrollment record, so a
   * late write cannot resurrect a record that nothing is left to clean up.
   */
  async cancel(did: string): Promise<void> {
    await this.deps.queue.remove(did)
    const inFlight = this.inFlight.get(did)
    if (inFlight) await inFlight.catch(() => undefined)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = await this.deps.queue.listDue(
        new Date().toISOString(),
        this.config.claimLimit,
      )
      for (const job of due) {
        await this.attempt(job)
      }
    } catch (err) {
      this.deps.logger?.warn({ err }, 'pds sync: tick failed')
    } finally {
      this.ticking = false
    }
  }

  private async attempt(job: AttemptJob): Promise<'ok' | 'deferred'> {
    const { did } = job
    if (this.inFlight.has(did)) return 'deferred'
    const running = this.execute(job)
    this.inFlight.set(did, running)
    try {
      return await running
    } finally {
      this.inFlight.delete(did)
    }
  }

  private async execute(job: AttemptJob): Promise<'ok' | 'deferred'> {
    const { did } = job
    try {
      const result = await this.deps.sync(did)
      const cleared = await this.deps.queue.removeIfCurrent(did, job.generation)
      if (!cleared) {
        // A mutation landed while this attempt was writing. Its job survives
        // and the ticker converges on the newer boundary set.
        this.deps.logger?.info(
          { did, generation: job.generation },
          'pds sync: superseded mid-attempt, newer job retained',
        )
      } else if (result === 'ok') {
        this.deps.logger?.info(
          { did, attemptCount: job.attemptCount },
          'pds sync: enrollment record written',
        )
      }
      return 'ok'
    } catch (err) {
      await this.recordFailure(job, err)
      return 'deferred'
    }
  }

  private async recordFailure(job: AttemptJob, err: unknown): Promise<void> {
    const { did, generation } = job
    const lastError = err instanceof Error ? err.message : String(err)
    const attemptCount = job.attemptCount + 1

    const terminal =
      classifyPdsSyncError(err) === 'terminal' ||
      attemptCount >= this.config.maxAttempts

    if (terminal) {
      await this.deps.queue.markFailed(did, generation, lastError)
      // Operator signal: the PDS record stays stale until the user
      // re-authorizes OAuth and the job is revived.
      this.deps.logger?.error(
        { did, attemptCount, lastError },
        'pds sync: terminal failure, enrollment record not updated',
      )
      return
    }

    const nextAttemptAt = new Date(
      Date.now() + this.backoffDelayMs(attemptCount),
    ).toISOString()
    await this.deps.queue.markRetry(
      did,
      generation,
      attemptCount,
      nextAttemptAt,
      lastError,
    )
    this.deps.logger?.warn(
      { did, attemptCount, nextAttemptAt, lastError },
      'pds sync: attempt failed, retry scheduled',
    )
  }

  private backoffDelayMs(attemptCount: number): number {
    const exponential = this.config.backoffBaseMs * 2 ** (attemptCount - 1)
    const capped = Math.min(exponential, this.config.backoffCapMs)
    return capped + Math.floor(Math.random() * BACKOFF_JITTER_MS)
  }
}
