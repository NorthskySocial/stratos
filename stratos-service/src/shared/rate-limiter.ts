import { XRPCError } from '@atproto/xrpc-server'

// Rate limit by DID as there's a perf drag when
// Concurrent messages for the same MST get too high

const DEFAULT_MAX_WRITES = 300
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_COOLDOWN_MS = 10_000

export class RateLimitError extends XRPCError {
  retryAfter: number

  constructor(retryAfterSec: number) {
    super(
      429,
      `Write rate limit exceeded. Try again in ${retryAfterSec}s.`,
      'RateLimitExceeded',
    )
    this.retryAfter = retryAfterSec
  }
}

interface DidState {
  timestamps: number[]
  cooldownUntil: number
}

export interface WriteRateLimiterOpts {
  maxWrites?: number
  windowMs?: number
  cooldownMs?: number
  cooldownJitterMs?: number
}

export interface WriteRateSnapshot {
  inWindow: number
  maxWrites: number
  windowMs: number
  cooldownUntil: number
  now: number
}

/**
 * Write rate limiter for DIDs.
 * This class manages a rate limiter for writes to a DID.
 * It allows a maximum number of writes within a specified time window.
 * If the limit is exceeded, the write is delayed until the cooldown period elapses.
 */
export class WriteRateLimiter {
  private state = new Map<string, DidState>()
  private readonly maxWrites: number
  private readonly windowMs: number
  private readonly cooldownMs: number
  private readonly cooldownJitterMs: number

  constructor(opts: WriteRateLimiterOpts = {}) {
    this.maxWrites = opts.maxWrites ?? DEFAULT_MAX_WRITES
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.cooldownJitterMs = opts.cooldownJitterMs ?? 0
  }

  /**
   * Assert that a write is allowed, throwing if not.
   * @param did - The DID for which the write is being checked.
   * @param count - The number of writes to check.
   *
   * @throws RateLimitError if the write is not allowed.
   */
  assertWriteAllowed(did: string, count = 1): void {
    const now = Date.now()
    let entry = this.state.get(did)

    if (!entry) {
      entry = { timestamps: [], cooldownUntil: 0 }
      this.state.set(did, entry)
    }

    if (now < entry.cooldownUntil) {
      const waitSec = Math.ceil((entry.cooldownUntil - now) / 1000)
      throw new RateLimitError(waitSec)
    }

    const windowStart = now - this.windowMs
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    if (entry.timestamps.length + count > this.maxWrites) {
      const jitter =
        this.cooldownJitterMs > 0
          ? Math.floor(Math.random() * this.cooldownJitterMs)
          : 0
      entry.cooldownUntil = now + this.cooldownMs + jitter
      const waitSec = Math.ceil((this.cooldownMs + jitter) / 1000)
      throw new RateLimitError(waitSec)
    }

    for (let i = 0; i < count; i++) {
      entry.timestamps.push(now)
    }
  }

  /**
   * Get a snapshot of the current write rate for a DID
   *
   * @param did - Decentralized Identifier (DID) for which to get the snapshot
   * @returns Write rate snapshot
   */
  getSnapshot(did: string): WriteRateSnapshot {
    const now = Date.now()
    const entry = this.state.get(did)
    if (!entry) {
      return {
        inWindow: 0,
        maxWrites: this.maxWrites,
        windowMs: this.windowMs,
        cooldownUntil: 0,
        now,
      }
    }

    const windowStart = now - this.windowMs
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    return {
      inWindow: entry.timestamps.length,
      maxWrites: this.maxWrites,
      windowMs: this.windowMs,
      cooldownUntil: entry.cooldownUntil,
      now,
    }
  }
}
