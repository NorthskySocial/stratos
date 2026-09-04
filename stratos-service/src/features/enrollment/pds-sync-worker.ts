import type { Logger } from '@northskysocial/stratos-core'
import {
  classifyPdsSyncError,
  type PdsEnrollmentSyncResult,
} from './internal/pds-enrollment-sync.js'
import type {
  PdsSyncJob,
  PdsSyncQueueStore,
} from './internal/pds-sync-store.js'
import { serviceMetrics } from '../../observability/metrics.js'
import {
  captureUnexpectedError,
  withTelemetrySpan,
} from '../../observability/runtime.js'

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
  /** Deadline per sync attempt; the signal aborts the PDS write. */
  attemptTimeoutMs: number
}

export interface PdsSyncWorkerDeps {
  queue: PdsSyncQueueStore
  sync(did: string, signal: AbortSignal): Promise<PdsEnrollmentSyncResult>
  logger?: Logger
}

/** Max random jitter added to each backoff delay. */
const BACKOFF_JITTER_MS = 1_000
/** Keep the claim valid while timeout cleanup updates the queue. */
const CLAIM_LEASE_GRACE_MS = 1_000

/** The unit of work an attempt fences itself against. */
type AttemptJob = Pick<PdsSyncJob, 'did' | 'attemptCount' | 'generation'>

interface InFlightAttempt {
  generation: number
  promise: Promise<'ok' | 'deferred'>
}

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
  private stopped = false
  private tickPromise?: Promise<void>
  private inFlight = new Map<string, InFlightAttempt>()
  /**
   * Per-DID chain that serializes {@link enqueue} against {@link cancel}. An
   * unserialized enqueue can clear the cancellation fence and insert a fresh
   * row mid-cancel; the cancel then deletes that newer row and the fresh
   * intent's inline attempt runs unfenced against a departing actor.
   */
  private mutations = new Map<string, Promise<void>>()
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
    this.stopped = false
    this.timer = setInterval(() => {
      void this.tick()
    }, this.config.tickMs)
    this.timer.unref()
    void this.refreshMetrics()
    void this.tick()
  }

  /**
   * Halt the ticker and wait for the active tick and in-flight attempts to
   * settle, so teardown cannot destroy storage under a running attempt.
   */
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    await this.tickPromise
    await Promise.allSettled([...this.inFlight.values()].map((v) => v.promise))
  }

  /**
   * Record durable sync intent for an actor. Called before the local mutation
   * commits, so a crash in between leaves a pending row rather than silence;
   * the job re-derives boundaries when it runs, so replaying it is harmless.
   *
   * @returns The generation to pass to the matching {@link kick}.
   */
  async enqueue(did: string): Promise<number> {
    return this.serialize(did, async () => {
      return this.deps.queue.upsertPending(did)
    })
  }

  /**
   * Run one inline attempt for a just-enqueued actor. Returns `'ok'` when the
   * PDS record was written (or the job was obsolete); `'deferred'` when the
   * attempt failed and the queue's retry/terminal bookkeeping was applied.
   */
  async kick(did: string, generation: number): Promise<'ok' | 'deferred'> {
    if (!(await this.deps.queue.isPending(did, generation))) return 'ok'
    return this.attempt({ did, attemptCount: 0, generation })
  }

  /** Fence an actor's job and wait for any local attempt to settle. */
  async cancel(did: string): Promise<void> {
    await this.serialize(did, async () => {
      const generation = await this.deps.queue.markCancelled(did)

      const inFlight = this.inFlight.get(did)
      if (
        inFlight &&
        (generation === undefined || inFlight.generation < generation)
      ) {
        await inFlight.promise.catch(() => undefined)
      }
    })
  }

  /**
   * Attempts do not take this lock: one that passes the `cancelled` check
   * registers in `inFlight` before any await, so {@link cancel} always sees
   * it. Only the fence state itself needs serializing.
   */
  private async serialize<T>(did: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutations.get(did) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.mutations.set(did, tail)
    try {
      return await run
    } finally {
      if (this.mutations.get(did) === tail) this.mutations.delete(did)
    }
  }

  private tick(): Promise<void> {
    if (this.ticking || this.stopped) return Promise.resolve()
    this.ticking = true
    this.tickPromise = this.runTick().finally(() => {
      this.ticking = false
    })
    return this.tickPromise
  }

  private async runTick(): Promise<void> {
    try {
      for (let claimed = 0; claimed < this.config.claimLimit; claimed += 1) {
        if (this.stopped) break
        const now = Date.now()
        const job = await this.deps.queue.claimDue(
          new Date(now).toISOString(),
          new Date(
            now + this.config.attemptTimeoutMs + CLAIM_LEASE_GRACE_MS,
          ).toISOString(),
        )
        if (!job || this.stopped) break
        await this.attempt(job)
      }
    } catch (err) {
      this.deps.logger?.warn({ err }, 'pds sync: tick failed')
    } finally {
      await this.refreshMetrics()
    }
  }

  private async attempt(job: AttemptJob): Promise<'ok' | 'deferred'> {
    const { did } = job
    if (this.inFlight.has(did)) return 'deferred'
    const running = Promise.resolve().then(() => this.execute(job))
    this.inFlight.set(did, { generation: job.generation, promise: running })
    try {
      return await running
    } finally {
      if (this.inFlight.get(did)?.promise === running) {
        this.inFlight.delete(did)
      }
    }
  }

  private async execute(job: AttemptJob): Promise<'ok' | 'deferred'> {
    const { did } = job
    try {
      const signal = AbortSignal.timeout(this.config.attemptTimeoutMs)
      const result = await withTelemetrySpan(
        'pds_sync.enrollment',
        'stratos.pds_sync',
        () => this.deps.sync(did, signal),
      )
      const completed = await this.deps.queue.markCompleted(did, job.generation)
      if (!completed) {
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
      serviceMetrics.recordPdsSyncAttempt('ok')
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
      serviceMetrics.recordPdsSyncAttempt('failed')
      captureUnexpectedError(err)
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
    serviceMetrics.recordPdsSyncAttempt('retry')
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

  private async refreshMetrics(): Promise<void> {
    const getStats = this.deps.queue.getStats
    if (!getStats) return
    try {
      serviceMetrics.setPdsSyncQueue(await getStats.call(this.deps.queue))
    } catch (error) {
      this.deps.logger?.warn({ error }, 'pds sync: metrics query failed')
    }
  }
}
