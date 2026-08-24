import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PdsEnrollmentSyncWorker,
  type PdsSyncWorkerConfig,
  type PdsSyncWorkerDeps,
} from '../src/features/enrollment/pds-sync-worker.js'
import { classifyPdsSyncError } from '../src/features/enrollment/internal/pds-enrollment-sync.js'
import type {
  PdsSyncJob,
  PdsSyncQueueStore,
} from '../src/features/enrollment/internal/pds-sync-store.js'

const USAGI = 'did:plc:usagitsukino'

const CONFIG: PdsSyncWorkerConfig = {
  tickMs: 30_000,
  backoffBaseMs: 30_000,
  backoffCapMs: 3_600_000,
  maxAttempts: 3,
}

/**
 * In-memory queue implementing the store contract closely enough to observe
 * the worker's scheduling decisions.
 */
class FakeQueue implements PdsSyncQueueStore {
  jobs = new Map<string, PdsSyncJob>()

  async upsertPending(did: string): Promise<void> {
    const now = new Date().toISOString()
    const existing = this.jobs.get(did)
    this.jobs.set(did, {
      did,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      firstQueuedAt: existing?.firstQueuedAt ?? now,
      updatedAt: now,
      lastError: null,
    })
  }

  async listDue(now: string, limit: number): Promise<PdsSyncJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'pending' && j.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit)
  }

  async markRetry(
    did: string,
    attemptCount: number,
    nextAttemptAt: string,
    lastError: string,
  ): Promise<void> {
    const job = this.jobs.get(did)
    if (!job) return
    this.jobs.set(did, {
      ...job,
      status: 'pending',
      attemptCount,
      nextAttemptAt,
      lastError,
      updatedAt: new Date().toISOString(),
    })
  }

  async markFailed(did: string, lastError: string): Promise<void> {
    const job = this.jobs.get(did)
    if (!job) return
    this.jobs.set(did, {
      ...job,
      status: 'failed',
      lastError,
      updatedAt: new Date().toISOString(),
    })
  }

  async remove(did: string): Promise<void> {
    this.jobs.delete(did)
  }

  async list(): Promise<PdsSyncJob[]> {
    return [...this.jobs.values()]
  }
}

function terminalError(): Error {
  const err = new Error('The session was deleted by another process')
  err.name = 'TokenRefreshError'
  return err
}

describe('PdsEnrollmentSyncWorker', () => {
  let queue: FakeQueue

  beforeEach(() => {
    queue = new FakeQueue()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('kick returns ok and removes the job on success', async () => {
    const sync = vi.fn().mockResolvedValue('ok')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    expect(queue.jobs.get(USAGI)?.status).toBe('pending')

    await expect(worker.kick(USAGI)).resolves.toBe('ok')
    expect(queue.jobs.has(USAGI)).toBe(false)
  })

  it('kick returns ok and removes the job when it is obsolete', async () => {
    const sync = vi.fn().mockResolvedValue('obsolete')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('ok')
    expect(queue.jobs.has(USAGI)).toBe(false)
  })

  it('kick returns deferred and schedules a backoff retry on transient failure', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)
    const start = Date.now()

    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('deferred')

    const job = queue.jobs.get(USAGI)
    expect(job?.status).toBe('pending')
    expect(job?.attemptCount).toBe(1)
    expect(job?.lastError).toBe('ECONNREFUSED')
    const delayMs = Date.parse(job!.nextAttemptAt) - start
    expect(delayMs).toBeGreaterThanOrEqual(30_000)
    expect(delayMs).toBeLessThan(31_001)
  })

  it('doubles the backoff on the second consecutive failure', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    await worker.kick(USAGI)

    // Force the retry due now; the immediate start tick picks it up.
    await queue.markRetry(USAGI, 1, new Date().toISOString(), 'ECONNREFUSED')
    worker.start()
    await vi.advanceTimersByTimeAsync(0)

    const job = queue.jobs.get(USAGI)
    expect(job?.attemptCount).toBe(2)
    const delayMs = Date.parse(job!.nextAttemptAt) - Date.now()
    expect(delayMs).toBeGreaterThanOrEqual(60_000)
    expect(delayMs).toBeLessThan(61_001)
    worker.stop()
  })

  it('caps the backoff delay at backoffCapMs', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('flaky'))
    const worker = new PdsEnrollmentSyncWorker(
      { queue, sync },
      { ...CONFIG, backoffCapMs: 45_000, maxAttempts: 12 },
    )

    await worker.enqueue(USAGI)
    await worker.kick(USAGI)
    await queue.markRetry(USAGI, 5, new Date().toISOString(), 'flaky')

    worker.start()
    await vi.advanceTimersByTimeAsync(0)

    const job = queue.jobs.get(USAGI)
    expect(job?.attemptCount).toBe(6)
    const delayMs = Date.parse(job!.nextAttemptAt) - Date.now()
    expect(delayMs).toBeLessThan(46_001)
    worker.stop()
  })

  it('marks the job failed on a terminal error', async () => {
    const sync = vi.fn().mockRejectedValue(terminalError())
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('deferred')

    const job = queue.jobs.get(USAGI)
    expect(job?.status).toBe('failed')
  })

  it('marks the job failed when attempts are exhausted', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('still down'))
    const worker = new PdsEnrollmentSyncWorker(
      { queue, sync },
      { ...CONFIG, maxAttempts: 2 },
    )

    await worker.enqueue(USAGI)
    await worker.kick(USAGI)
    expect(queue.jobs.get(USAGI)?.status).toBe('pending')

    // Make the retry due now, then let the ticker exhaust the budget.
    await queue.markRetry(USAGI, 1, new Date().toISOString(), 'still down')
    worker.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(queue.jobs.get(USAGI)?.status).toBe('failed')
    worker.stop()
  })

  it('recovers pending jobs immediately on start', async () => {
    const sync = vi.fn().mockResolvedValue('ok')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    worker.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(sync).toHaveBeenCalledWith(USAGI)
    expect(queue.jobs.has(USAGI)).toBe(false)
    worker.stop()
  })

  it('superseding mutations converge: the retry writes current state once', async () => {
    const sync = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('ok')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    // First mutation fails inline.
    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('deferred')

    // Second mutation on the same actor resets the row and succeeds inline.
    await worker.enqueue(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('ok')
    expect(queue.jobs.has(USAGI)).toBe(false)

    // No stale retry remains for the ticker to replay.
    worker.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sync).toHaveBeenCalledTimes(2)
    worker.stop()
  })

  it('does not run the same actor concurrently', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sync = vi.fn().mockImplementation(async () => {
      await gate
      return 'ok'
    })
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    const first = worker.kick(USAGI)
    await expect(worker.kick(USAGI)).resolves.toBe('deferred')

    release()
    await expect(first).resolves.toBe('ok')
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('logs the write only when a record was actually written', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sync = vi.fn().mockResolvedValue('ok')
    const worker = new PdsEnrollmentSyncWorker(
      {
        queue,
        sync,
        logger: logger as unknown as PdsSyncWorkerDeps['logger'],
      },
      CONFIG,
    )

    await worker.enqueue(USAGI)
    await worker.kick(USAGI)
    expect(logger.info).toHaveBeenCalledWith(
      { did: USAGI, attemptCount: 0 },
      'pds sync: enrollment record written',
    )

    logger.info.mockClear()
    sync.mockResolvedValue('obsolete')
    await worker.enqueue(USAGI)
    await worker.kick(USAGI)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('adds jitter on top of the exponential backoff delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const sync = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)
    const start = Date.now()

    await worker.enqueue(USAGI)
    await worker.kick(USAGI)

    const job = queue.jobs.get(USAGI)
    expect(Date.parse(job!.nextAttemptAt) - start).toBe(30_500)
  })

  it('stop halts the ticker', async () => {
    const sync = vi.fn().mockResolvedValue('ok')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    worker.stop()

    await worker.enqueue(USAGI)
    await vi.advanceTimersByTimeAsync(CONFIG.tickMs * 3)
    expect(sync).not.toHaveBeenCalled()
  })

  it('start is idempotent, so one stop halts every ticker', async () => {
    const sync = vi.fn().mockResolvedValue('ok')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    worker.start()
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    worker.stop()

    await worker.enqueue(USAGI)
    await vi.advanceTimersByTimeAsync(CONFIG.tickMs * 3)
    expect(sync).not.toHaveBeenCalled()
  })

  it('logs and keeps ticking when the queue read fails', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sync = vi.fn().mockResolvedValue('ok')
    vi.spyOn(queue, 'listDue').mockRejectedValueOnce(new Error('db locked'))
    const worker = new PdsEnrollmentSyncWorker(
      {
        queue,
        sync,
        logger: logger as unknown as PdsSyncWorkerDeps['logger'],
      },
      CONFIG,
    )

    await worker.enqueue(USAGI)
    worker.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'pds sync: tick failed',
    )
    expect(sync).not.toHaveBeenCalled()

    // The ticker survives the failed read and picks the job up next tick.
    await vi.advanceTimersByTimeAsync(CONFIG.tickMs)
    expect(sync).toHaveBeenCalledWith(USAGI)
    worker.stop()
  })

  it('survives a failed queue read when no logger is set', async () => {
    const sync = vi.fn().mockResolvedValue('ok')
    vi.spyOn(queue, 'listDue').mockRejectedValueOnce(new Error('db locked'))
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(CONFIG.tickMs)

    expect(sync).toHaveBeenCalledWith(USAGI)
    worker.stop()
  })

  it('logs the retry schedule and then the terminal failure', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sync = vi.fn().mockRejectedValue(new Error('still down'))
    const worker = new PdsEnrollmentSyncWorker(
      {
        queue,
        sync,
        logger: logger as unknown as PdsSyncWorkerDeps['logger'],
      },
      { ...CONFIG, maxAttempts: 2 },
    )

    await worker.enqueue(USAGI)
    await worker.kick(USAGI)
    expect(logger.warn).toHaveBeenCalledWith(
      {
        did: USAGI,
        attemptCount: 1,
        nextAttemptAt: expect.any(String),
        lastError: 'still down',
      },
      'pds sync: attempt failed, retry scheduled',
    )

    await queue.markRetry(USAGI, 1, new Date().toISOString(), 'still down')
    worker.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(logger.error).toHaveBeenCalledWith(
      { did: USAGI, attemptCount: 2, lastError: 'still down' },
      'pds sync: terminal failure, enrollment record not updated',
    )
    worker.stop()
  })

  it('skips a tick while the previous tick is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sync = vi.fn().mockImplementation(async () => {
      await gate
      return 'ok'
    })
    const listDue = vi.spyOn(queue, 'listDue')
    const worker = new PdsEnrollmentSyncWorker({ queue, sync }, CONFIG)

    await worker.enqueue(USAGI)
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(CONFIG.tickMs)
    expect(listDue).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    worker.stop()
  })
})

describe('classifyPdsSyncError', () => {
  it.each([
    ['TokenRefreshError by name', terminalError(), 'terminal'],
    [
      'TokenRevokedError by name',
      Object.assign(new Error('revoked'), { name: 'TokenRevokedError' }),
      'terminal',
    ],
    [
      'TokenInvalidError by name',
      Object.assign(new Error('invalid'), { name: 'TokenInvalidError' }),
      'terminal',
    ],
    [
      'invalid_grant OAuth error field',
      Object.assign(new Error('oauth'), { error: 'invalid_grant' }),
      'terminal',
    ],
    [
      'HTTP 401 status',
      Object.assign(new Error('unauthorized'), { status: 401 }),
      'terminal',
    ],
    [
      'HTTP 403 status',
      Object.assign(new Error('forbidden'), { status: 403 }),
      'terminal',
    ],
    ['network error', new Error('ECONNREFUSED'), 'transient'],
    [
      'HTTP 500 status',
      Object.assign(new Error('boom'), { status: 500 }),
      'transient',
    ],
    ['non-Error value', 'a string', 'transient'],
    ['null', null, 'transient'],
    ['undefined', undefined, 'transient'],
  ])('classifies %s as %s', (_label, err, expected) => {
    expect(classifyPdsSyncError(err)).toBe(expected)
  })

  it('classifies by constructor name when this.name is not set', () => {
    class TokenRefreshError extends Error {}
    expect(classifyPdsSyncError(new TokenRefreshError('no session'))).toBe(
      'terminal',
    )
  })
})
