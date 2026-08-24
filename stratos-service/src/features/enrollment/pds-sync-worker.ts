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
}

/**
 * Dependencies for the PDS enrollment sync worker.
 */
export interface PdsSyncWorkerDeps {
  queue: PdsSyncQueueStore
  sync(did: string): Promise<PdsEnrollmentSyncResult>
  logger?: Logger
}

/** Jobs claimed per tick; volume is admin-mutation-scale. */
const CLAIM_LIMIT = 10

/** Max random jitter added to each backoff delay. */
const BACKOFF_JITTER_MS = 1_000

/**
 * Durable retry worker for PDS enrollment-record sync jobs.
 *
 * A ticker executes due `'pending'` jobs with capped exponential backoff.
 * Terminal failures (expired/revoked OAuth sessions, attempt exhaustion) are
 * marked `'failed'` and surfaced via an error log plus the observability
 * endpoint; only a fresh admin mutation revives them.
 */
export class PdsEnrollmentSyncWorker {
  private timer?: NodeJS.Timeout
  private ticking = false
  private inFlight = new Set<string>()

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
   * Record durable sync intent for an actor. Called before any PDS network
   * I/O so a crash between the local commit and the PDS write leaves a
   * pending row, not silence.
   */
  async enqueue(did: string): Promise<void> {
    await this.deps.queue.upsertPending(did)
  }

  /**
   * Run one inline attempt for a just-enqueued actor. Returns `'ok'` when the
   * PDS record was written (or the job was obsolete); `'deferred'` when the
   * attempt failed and the queue's retry/terminal bookkeeping was applied.
   */
  async kick(did: string): Promise<'ok' | 'deferred'> {
    return this.attempt({ did, attemptCount: 0 })
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = await this.deps.queue.listDue(
        new Date().toISOString(),
        CLAIM_LIMIT,
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

  private async attempt(
    job: Pick<PdsSyncJob, 'did' | 'attemptCount'>,
  ): Promise<'ok' | 'deferred'> {
    const { did } = job
    if (this.inFlight.has(did)) return 'deferred'
    this.inFlight.add(did)
    try {
      const result = await this.deps.sync(did)
      await this.deps.queue.remove(did)
      if (result === 'ok') {
        this.deps.logger?.info(
          { did, attemptCount: job.attemptCount },
          'pds sync: enrollment record written',
        )
      }
      return 'ok'
    } catch (err) {
      await this.recordFailure(job, err)
      return 'deferred'
    } finally {
      this.inFlight.delete(did)
    }
  }

  private async recordFailure(
    job: Pick<PdsSyncJob, 'did' | 'attemptCount'>,
    err: unknown,
  ): Promise<void> {
    const { did } = job
    const lastError = err instanceof Error ? err.message : String(err)
    const attemptCount = job.attemptCount + 1

    const terminal =
      classifyPdsSyncError(err) === 'terminal' ||
      attemptCount >= this.config.maxAttempts

    if (terminal) {
      await this.deps.queue.markFailed(did, lastError)
      // Operator signal: the PDS record stays stale until the user
      // re-authorizes OAuth and an admin mutation revives the job.
      this.deps.logger?.error(
        { did, attemptCount, lastError },
        'pds sync: terminal failure, enrollment record not updated',
      )
      return
    }

    const nextAttemptAt = new Date(
      Date.now() + this.backoffDelayMs(attemptCount),
    ).toISOString()
    await this.deps.queue.markRetry(did, attemptCount, nextAttemptAt, lastError)
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
